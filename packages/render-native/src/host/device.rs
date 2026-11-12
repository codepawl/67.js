use std::borrow::Cow;

use napi::{Error, Result};
use wgpu::util::DeviceExt;

pub(crate) fn failure(message: impl Into<String>) -> Error {
    Error::from_reason(message.into())
}

/// The bytes of a storage buffer: a multiple of four long and at least 16. Bytes that already fit are borrowed, so a texel
/// pool of hundreds of megabytes is not copied once more on the host before it reaches the GPU.
pub(crate) fn padded_storage_bytes(bytes: &[u8]) -> Cow<'_, [u8]> {
    let padded_length = bytes.len().next_multiple_of(4).max(16);
    if padded_length == bytes.len() {
        return Cow::Borrowed(bytes);
    }
    let mut padded = bytes.to_vec();
    padded.resize(padded_length, 0);
    Cow::Owned(padded)
}

pub(crate) fn storage_buffer(device: &wgpu::Device, label: &str, bytes: &[u8]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: &padded_storage_bytes(bytes),
        usage: wgpu::BufferUsages::STORAGE,
    })
}

pub(crate) fn layout_entry(binding: u32, binding_type: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: binding_type,
        count: None,
    }
}

pub(crate) fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    layout_entry(
        binding,
        wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
    )
}

pub(crate) fn open_device() -> Result<(wgpu::Device, wgpu::Queue, wgpu::AdapterInfo)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .map_err(|error| failure(format!("No Vulkan adapter: {error}")))?;
    if !adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
        return Err(failure("The Vulkan adapter does not support ray queries."));
    }
    let adapter_limits = adapter.limits();
    let required_limits = wgpu::Limits {
        max_storage_buffer_binding_size: adapter_limits.max_storage_buffer_binding_size.min(1 << 30),
        max_buffer_size: adapter_limits.max_buffer_size.min(1 << 30),
        // The light bake binds nine storage buffers (the scene, the accumulation and the texels); the default allows eight.
        max_storage_buffers_per_shader_stage: adapter_limits.max_storage_buffers_per_shader_stage.min(16),
        ..wgpu::Limits::default()
    }
    .using_minimum_supported_acceleration_structure_values();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("render-native"),
        required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
        required_limits,
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    }))
    .map_err(|error| failure(format!("Could not open the device: {error}")))?;
    Ok((device, queue, adapter.get_info()))
}

#[cfg(test)]
mod tests {
    use super::padded_storage_bytes;
    use std::borrow::Cow;

    #[test]
    fn padded_storage_bytes_borrows_bytes_that_already_fit() {
        let bytes = [7u8; 32];
        let padded = padded_storage_bytes(&bytes);
        assert!(matches!(padded, Cow::Borrowed(_)));
        assert_eq!(padded.as_ptr(), bytes.as_ptr());
    }

    #[test]
    fn padded_storage_bytes_pads_short_and_unaligned_input_with_zeros() {
        assert_eq!(padded_storage_bytes(&[]).len(), 16);
        let unaligned = padded_storage_bytes(&[1u8; 18]);
        assert_eq!(unaligned.len(), 20);
        assert_eq!(&unaligned[18..], &[0u8, 0u8]);
        assert_eq!(&unaligned[..18], &[1u8; 18]);
    }
}
