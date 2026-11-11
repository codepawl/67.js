use wgpu::util::DeviceExt;

use crate::host::textures::material_is_cutout;

pub(crate) const TRIANGLE_FLOATS: usize = 9 * 4;
const VERTEX_STRIDE_BYTES: u64 = 12;

pub(crate) struct UnpackedTriangles {
    pub(crate) vertices: Vec<f32>,
    pub(crate) slot_map: Vec<u32>,
    pub(crate) opaque_count: usize,
}

/// Unpacks corner-plus-two-edges triangle rows into three 3D corners per triangle, placing opaque triangles before
/// alpha-cutout triangles so each hardware BLAS geometry has a uniform opacity flag.
pub(crate) fn unpack_triangles(triangle_data: &[f32], materials: &[f32], triangle_count: usize) -> UnpackedTriangles {
    let mut opaque_vertices: Vec<f32> = Vec::with_capacity(triangle_count * 9);
    let mut cutout_vertices: Vec<f32> = Vec::new();
    let mut slot_map: Vec<u32> = Vec::with_capacity(triangle_count);
    let mut cutout_slots: Vec<u32> = Vec::new();
    for (slot, triangle) in triangle_data.chunks_exact(TRIANGLE_FLOATS).enumerate() {
        let corner = [triangle[0], triangle[1], triangle[2]];
        let edge_first = [triangle[4], triangle[5], triangle[6]];
        let edge_second = [triangle[8], triangle[9], triangle[10]];
        let is_cutout = material_is_cutout(materials, triangle[3] as usize);
        let vertices = if is_cutout { &mut cutout_vertices } else { &mut opaque_vertices };
        vertices.extend_from_slice(&corner);
        vertices.extend((0..3).map(|axis| corner[axis] + edge_first[axis]));
        vertices.extend((0..3).map(|axis| corner[axis] + edge_second[axis]));
        if is_cutout {
            cutout_slots.push(slot as u32);
        } else {
            slot_map.push(slot as u32);
        }
    }
    let opaque_count = slot_map.len();
    slot_map.extend(cutout_slots);
    let mut vertices = opaque_vertices;
    vertices.extend(cutout_vertices);
    UnpackedTriangles {
        vertices,
        slot_map,
        opaque_count,
    }
}

pub(crate) fn create_vertex_buffer(device: &wgpu::Device, vertices: &[f32]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("triangle corners"),
        contents: bytemuck::cast_slice(vertices),
        usage: wgpu::BufferUsages::BLAS_INPUT,
    })
}

/// Builds the scene BLAS (split into opaque and candidate cutout geometries) and single-instance TLAS.
pub(crate) fn build_acceleration_structure(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    vertex_buffer: &wgpu::Buffer,
    triangle_count: usize,
    opaque_count: usize,
) -> wgpu::Tlas {
    let mut geometry_sizes: Vec<wgpu::BlasTriangleGeometrySizeDescriptor> = Vec::new();
    let mut geometry_vertex_starts: Vec<u32> = Vec::new();
    let cutout_count = triangle_count - opaque_count;
    for (first_triangle, triangles_in_geometry, flags) in [
        (0, opaque_count, wgpu::AccelerationStructureGeometryFlags::OPAQUE),
        (opaque_count, cutout_count, wgpu::AccelerationStructureGeometryFlags::empty()),
    ] {
        if triangles_in_geometry == 0 {
            continue;
        }
        geometry_vertex_starts.push((first_triangle * 3) as u32);
        geometry_sizes.push(wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: (triangles_in_geometry * 3) as u32,
            index_format: None,
            index_count: None,
            flags,
        });
    }
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: Some("scene"),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: geometry_sizes.clone(),
        },
    );
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("scene"),
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        max_instances: 1,
    });
    tlas[0] = Some(wgpu::TlasInstance::new(
        &blas,
        [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        0,
        0xFF,
    ));
    let triangle_geometries: Vec<wgpu::BlasTriangleGeometry> = geometry_sizes
        .iter()
        .zip(&geometry_vertex_starts)
        .map(|(size, first_vertex)| wgpu::BlasTriangleGeometry {
            size,
            vertex_buffer,
            first_vertex: *first_vertex,
            vertex_stride: VERTEX_STRIDE_BYTES,
            index_buffer: None,
            first_index: None,
            transform_buffer: None,
            transform_buffer_offset: None,
        })
        .collect();
    let mut build_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("build"),
    });
    build_encoder.build_acceleration_structures(
        std::iter::once(&wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(triangle_geometries),
        }),
        std::iter::once(&tlas),
    );
    queue.submit(Some(build_encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    tlas
}
