//! The per-frame skin kernel of src/skinning.js in Rust, for the WebAssembly comparison in bench/wasm-skin.
//! `skin_update` matches `updateSkinPose` and `skin_validate` matches `validateSkinPose` for Float32 inputs:
//! every product is computed in f64 in gl-matrix order and stored as f32, as the JavaScript does.
//! Status codes: 0 ok, 1 non-finite value, 2 not affine, 3 singular joint transform, 4 mesh world not invertible,
//! 5 singular weighted vertex transform, 6 reflected weighted transform.

use std::alloc::{alloc, Layout};

#[no_mangle]
pub extern "C" fn allocate(bytes: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align(bytes.max(8), 8).unwrap()) }
}

fn determinant(values: &[f32]) -> f64 {
    let (xx, yx, zx) = (values[0] as f64, values[1] as f64, values[2] as f64);
    let (xy, yy, zy) = (values[4] as f64, values[5] as f64, values[6] as f64);
    let (xz, yz, zz) = (values[8] as f64, values[9] as f64, values[10] as f64);
    xx * (yy * zz - yz * zy) - xy * (yx * zz - yz * zx) + xz * (yx * zy - yy * zx)
}

fn validate_matrices(values: &[f32]) -> i32 {
    if values.iter().any(|value| !value.is_finite()) {
        return 1;
    }
    for matrix in values.chunks_exact(16) {
        if matrix[3] != 0.0 || matrix[7] != 0.0 || matrix[11] != 0.0 || matrix[15] != 1.0 {
            return 2;
        }
        if determinant(matrix).abs() < 1e-10 {
            return 3;
        }
    }
    0
}

fn multiply(output: &mut [f32; 16], left: &[f32; 16], right: &[f32; 16]) {
    let a: [f64; 16] = left.map(|value| value as f64);
    for column in 0..4 {
        let b0 = right[column * 4] as f64;
        let b1 = right[column * 4 + 1] as f64;
        let b2 = right[column * 4 + 2] as f64;
        let b3 = right[column * 4 + 3] as f64;
        for row in 0..4 {
            output[column * 4 + row] = (b0 * a[row] + b1 * a[4 + row] + b2 * a[8 + row] + b3 * a[12 + row]) as f32;
        }
    }
}

fn invert(output: &mut [f32; 16], matrix: &[f32; 16]) -> bool {
    let a: [f64; 16] = matrix.map(|value| value as f64);
    let (a00, a01, a02, a03) = (a[0], a[1], a[2], a[3]);
    let (a10, a11, a12, a13) = (a[4], a[5], a[6], a[7]);
    let (a20, a21, a22, a23) = (a[8], a[9], a[10], a[11]);
    let (a30, a31, a32, a33) = (a[12], a[13], a[14], a[15]);
    let b00 = a00 * a11 - a01 * a10;
    let b01 = a00 * a12 - a02 * a10;
    let b02 = a00 * a13 - a03 * a10;
    let b03 = a01 * a12 - a02 * a11;
    let b04 = a01 * a13 - a03 * a11;
    let b05 = a02 * a13 - a03 * a12;
    let b06 = a20 * a31 - a21 * a30;
    let b07 = a20 * a32 - a22 * a30;
    let b08 = a20 * a33 - a23 * a30;
    let b09 = a21 * a32 - a22 * a31;
    let b10 = a21 * a33 - a23 * a31;
    let b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if det == 0.0 || det.is_nan() {
        return false;
    }
    let det = 1.0 / det;
    let values = [
        (a11 * b11 - a12 * b10 + a13 * b09) * det,
        (a02 * b10 - a01 * b11 - a03 * b09) * det,
        (a31 * b05 - a32 * b04 + a33 * b03) * det,
        (a22 * b04 - a21 * b05 - a23 * b03) * det,
        (a12 * b08 - a10 * b11 - a13 * b07) * det,
        (a00 * b11 - a02 * b08 + a03 * b07) * det,
        (a32 * b02 - a30 * b05 - a33 * b01) * det,
        (a20 * b05 - a22 * b02 + a23 * b01) * det,
        (a10 * b10 - a11 * b08 + a13 * b06) * det,
        (a01 * b08 - a00 * b10 - a03 * b06) * det,
        (a30 * b04 - a31 * b02 + a33 * b00) * det,
        (a21 * b02 - a20 * b04 - a23 * b00) * det,
        (a11 * b07 - a10 * b09 - a12 * b06) * det,
        (a00 * b09 - a01 * b07 + a02 * b06) * det,
        (a31 * b01 - a30 * b03 - a32 * b00) * det,
        (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ];
    for index in 0..16 {
        output[index] = values[index] as f32;
    }
    true
}

fn matrix_at(values: &[f32], index: usize) -> [f32; 16] {
    values[index * 16..index * 16 + 16].try_into().unwrap()
}

/// palette = inverse(meshWorld) * jointWorld * inverseBind * bind for each joint, then the palette checks.
#[no_mangle]
pub unsafe extern "C" fn skin_update(count: usize, joint_world: *const f32, inverse_bind: *const f32, mesh_world: *const f32, bind: *const f32, palette: *mut f32) -> i32 {
    let joint_world = std::slice::from_raw_parts(joint_world, count * 16);
    let inverse_bind = std::slice::from_raw_parts(inverse_bind, count * 16);
    let mesh_world = std::slice::from_raw_parts(mesh_world, 16);
    let bind = std::slice::from_raw_parts(bind, 16);
    let palette = std::slice::from_raw_parts_mut(palette, count * 16);
    for (values, _) in [(joint_world, 0), (inverse_bind, 0), (mesh_world, 0), (bind, 0)] {
        let status = validate_matrices(values);
        if status != 0 {
            return status;
        }
    }
    let mesh_world = matrix_at(mesh_world, 0);
    let bind = matrix_at(bind, 0);
    let mut mesh_inverse = [0.0f32; 16];
    if !invert(&mut mesh_inverse, &mesh_world) {
        return 4;
    }
    let status = validate_matrices(&mesh_inverse);
    if status != 0 {
        return status;
    }
    let mut product = [0.0f32; 16];
    let mut step = [0.0f32; 16];
    for joint in 0..count {
        multiply(&mut product, &matrix_at(joint_world, joint), &matrix_at(inverse_bind, joint));
        multiply(&mut step, &product, &bind);
        multiply(&mut product, &mesh_inverse, &step);
        palette[joint * 16..joint * 16 + 16].copy_from_slice(&product);
    }
    validate_matrices(palette)
}

/// The palette checks plus one weighted 3x3 determinant per distinct influence set.
#[no_mangle]
pub unsafe extern "C" fn skin_validate(palette: *const f32, joint_count: usize, joints: *const i32, weights: *const f32, set_count: usize, world_determinant: f64, has_world: i32) -> i32 {
    let matrices = std::slice::from_raw_parts(palette, joint_count * 16);
    let joints = std::slice::from_raw_parts(joints, set_count * 4);
    let weights = std::slice::from_raw_parts(weights, set_count * 4);
    let status = validate_matrices(matrices);
    if status != 0 {
        return status;
    }
    for set in 0..set_count {
        let mut sum = [0.0f64; 9];
        for influence in 0..4 {
            let weight = weights[set * 4 + influence] as f64;
            let offset = joints[set * 4 + influence] as usize * 16;
            let source = [0usize, 1, 2, 4, 5, 6, 8, 9, 10];
            for (slot, component) in source.iter().enumerate() {
                sum[slot] += matrices[offset + component] as f64 * weight;
            }
        }
        let [xx, yx, zx, xy, yy, zy, xz, yz, zz] = sum;
        let det = xx * (yy * zz - yz * zy) - xy * (yx * zz - yz * zx) + xz * (yx * zy - yy * zx);
        if !det.is_finite() || det.abs() < 1e-8 {
            return 5;
        }
        if has_world != 0 && det * world_determinant < 0.0 {
            return 6;
        }
    }
    0
}
