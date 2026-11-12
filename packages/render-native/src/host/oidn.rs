//! A persistent Intel Open Image Denoise device and filter (issue #1025). The OIDN shared library is opened at run time, so
//! the addon builds and loads without it. The device, the four image buffers and the committed "RT" filter stay alive
//! between calls and are rebuilt only when the image size, the set of guides or the settings change, so a warm call costs
//! the buffer writes, the filter and the read back.
//!
//! The C names and enum values come from `include/OpenImageDenoise/oidn.h` of OIDN 2.5.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::time::Instant;

use libloading::Library;
use napi::bindgen_prelude::Float32Array;
use napi::Result;
use napi_derive::napi;

use crate::host::device::failure;

type Handle = *mut c_void;

const FORMAT_FLOAT3: c_int = 3;
const BYTES_PER_PIXEL: usize = 12;
// Keeps width * height * 12 far below the range of usize, so the length checks cannot wrap.
const MAXIMUM_IMAGE_SIDE: usize = 65_536;
const ERROR_NONE: c_int = 0;

const DEVICE_NAMES: [(&str, c_int); 6] = [("default", 0), ("cpu", 1), ("sycl", 2), ("cuda", 3), ("hip", 4), ("metal", 5)];
const QUALITY_NAMES: [(&str, c_int); 4] = [("default", 0), ("fast", 4), ("balanced", 5), ("high", 6)];

/// How a device name becomes an OIDN device: a type, or a physical device index.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum DeviceChoice {
    Type(c_int),
    PhysicalIndex(c_int),
}

fn parse_device(name: &str) -> Result<DeviceChoice> {
    let lowered = name.trim().to_ascii_lowercase();
    if let Some((_, device_type)) = DEVICE_NAMES.iter().find(|(known, _)| *known == lowered) {
        return Ok(DeviceChoice::Type(*device_type));
    }
    if let Ok(index) = lowered.parse::<c_int>() {
        if index >= 0 {
            return Ok(DeviceChoice::PhysicalIndex(index));
        }
    }
    Err(failure(format!(
        "OIDN device {name:?} is unknown: pass \"cpu\", \"cuda\", \"hip\", \"sycl\", \"metal\", \"default\" or a physical device index."
    )))
}

fn parse_quality(name: &str) -> Result<c_int> {
    QUALITY_NAMES
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, value)| *value)
        .ok_or_else(|| failure(format!("OIDN quality {name:?} is unknown: pass \"default\", \"fast\", \"balanced\" or \"high\".")))
}

/// The OIDN entry points this module calls, copied out of the library as plain function pointers.
struct OidnApi {
    new_device: unsafe extern "C" fn(c_int) -> Handle,
    new_device_by_id: unsafe extern "C" fn(c_int) -> Handle,
    set_device_int: unsafe extern "C" fn(Handle, *const c_char, c_int),
    commit_device: unsafe extern "C" fn(Handle),
    sync_device: unsafe extern "C" fn(Handle),
    release_device: unsafe extern "C" fn(Handle),
    get_device_error: unsafe extern "C" fn(Handle, *mut *const c_char) -> c_int,
    new_buffer: unsafe extern "C" fn(Handle, usize) -> Handle,
    write_buffer: unsafe extern "C" fn(Handle, usize, usize, *const c_void),
    read_buffer: unsafe extern "C" fn(Handle, usize, usize, *mut c_void),
    release_buffer: unsafe extern "C" fn(Handle),
    new_filter: unsafe extern "C" fn(Handle, *const c_char) -> Handle,
    set_filter_image: unsafe extern "C" fn(Handle, *const c_char, Handle, c_int, usize, usize, usize, usize, usize),
    set_filter_bool: unsafe extern "C" fn(Handle, *const c_char, bool),
    set_filter_int: unsafe extern "C" fn(Handle, *const c_char, c_int),
    commit_filter: unsafe extern "C" fn(Handle),
    execute_filter: unsafe extern "C" fn(Handle),
    release_filter: unsafe extern "C" fn(Handle),
    // Declared last: the pointers above stay valid only while the library is loaded.
    _library: Library,
}

/// Looks one entry point up by name.
///
/// # Safety
/// `Function` must be the exact `extern "C"` signature of the named OIDN function.
unsafe fn load_function<Function: Copy>(library: &Library, name: &str) -> Result<Function> {
    let symbol = library
        .get::<Function>(name.as_bytes())
        .map_err(|error| failure(format!("The OIDN library has no function {name} ({error}): it is not OIDN 2.5 or newer.")))?;
    Ok(*symbol)
}

impl OidnApi {
    fn open(library_path: &str) -> Result<Self> {
        // SAFETY: opening a shared library runs its initialisers; the caller names the official OIDN library.
        let library = unsafe { Library::new(library_path) }.map_err(|error| {
            failure(format!("Could not load the OIDN library at {library_path:?} ({error}): run `npm run fetch` in the denoise package, or pass libraryPath."))
        })?;
        // SAFETY: every signature below is the one declared in oidn.h of OIDN 2.5.
        unsafe {
            Ok(Self {
                new_device: load_function(&library, "oidnNewDevice")?,
                new_device_by_id: load_function(&library, "oidnNewDeviceByID")?,
                set_device_int: load_function(&library, "oidnSetDeviceInt")?,
                commit_device: load_function(&library, "oidnCommitDevice")?,
                sync_device: load_function(&library, "oidnSyncDevice")?,
                release_device: load_function(&library, "oidnReleaseDevice")?,
                get_device_error: load_function(&library, "oidnGetDeviceError")?,
                new_buffer: load_function(&library, "oidnNewBuffer")?,
                write_buffer: load_function(&library, "oidnWriteBuffer")?,
                read_buffer: load_function(&library, "oidnReadBuffer")?,
                release_buffer: load_function(&library, "oidnReleaseBuffer")?,
                new_filter: load_function(&library, "oidnNewFilter")?,
                set_filter_image: load_function(&library, "oidnSetFilterImage")?,
                set_filter_bool: load_function(&library, "oidnSetFilterBool")?,
                set_filter_int: load_function(&library, "oidnSetFilterInt")?,
                commit_filter: load_function(&library, "oidnCommitFilter")?,
                execute_filter: load_function(&library, "oidnExecuteFilter")?,
                release_filter: load_function(&library, "oidnReleaseFilter")?,
                _library: library,
            })
        }
    }

    /// Turns the device's pending error, or the global one for a null device, into a message.
    fn pending_error(&self, device: Handle) -> Option<String> {
        let mut message: *const c_char = std::ptr::null();
        // SAFETY: a null device asks for the global error; `message` is written by OIDN and valid until the next call.
        let code = unsafe { (self.get_device_error)(device, &mut message) };
        if code == ERROR_NONE {
            return None;
        }
        let text = if message.is_null() {
            "no message".to_string()
        } else {
            // SAFETY: OIDN returns a NUL terminated string.
            unsafe { CStr::from_ptr(message) }.to_string_lossy().into_owned()
        };
        Some(format!("{text} (OIDN error {code})"))
    }
}

/// What a committed filter was built for. A call with another key rebuilds the buffers and the filter.
#[derive(PartialEq, Eq, Clone, Copy)]
struct FilterKey {
    width: usize,
    height: usize,
    has_albedo: bool,
    has_normal: bool,
}

#[napi(object)]
pub struct OidnDenoiserOptions {
    pub library_path: String,
    /// `"cpu"` (default), `"cuda"`, `"hip"`, `"sycl"`, `"metal"`, `"default"` or a physical device index.
    pub device: Option<String>,
    /// `"default"`, `"fast"`, `"balanced"` or `"high"` (default).
    pub quality: Option<String>,
    pub clean_aux: Option<bool>,
    /// CPU thread count; absent or 0 lets OIDN choose.
    pub threads: Option<u32>,
}

#[napi(object)]
pub struct OidnDenoiseCall {
    pub width: u32,
    pub height: u32,
    /// Linear HDR radiance, three floats per pixel, rows top to bottom.
    pub color: Float32Array,
    pub albedo: Option<Float32Array>,
    /// Needs `albedo`.
    pub normal: Option<Float32Array>,
}

#[napi(object)]
pub struct OidnDenoiseResult {
    pub color: Float32Array,
    /// True when this call rebuilt the buffers and committed the filter (the first call, or a changed size or guide set).
    pub recommitted: bool,
    /// Buffer allocation, filter creation and commit; 0 when the committed filter was reused.
    pub commit_seconds: f64,
    pub write_seconds: f64,
    pub execute_seconds: f64,
    pub read_seconds: f64,
}

/// A device and filter kept alive between calls.
#[napi]
pub struct OidnDenoiser {
    api: OidnApi,
    device: Handle,
    quality: c_int,
    clean_aux: bool,
    device_seconds: f64,
    key: Option<FilterKey>,
    filter: Handle,
    color_buffer: Handle,
    albedo_buffer: Handle,
    normal_buffer: Handle,
    output_buffer: Handle,
}

// SAFETY: the handles are used only through `&mut self`, one call at a time.
unsafe impl Send for OidnDenoiser {}

fn name_to_c(name: &str) -> CString {
    CString::new(name).expect("names in this module have no NUL byte")
}

#[napi]
impl OidnDenoiser {
    #[napi(constructor)]
    pub fn new(options: OidnDenoiserOptions) -> Result<Self> {
        let device_name = options.device.as_deref().unwrap_or("cpu");
        let choice = parse_device(device_name)?;
        let quality = parse_quality(options.quality.as_deref().unwrap_or("high"))?;
        let api = OidnApi::open(&options.library_path)?;
        let started = Instant::now();
        // SAFETY: plain OIDN calls with valid arguments; a null device means creation failed.
        let device = unsafe {
            match choice {
                DeviceChoice::Type(device_type) => (api.new_device)(device_type),
                DeviceChoice::PhysicalIndex(index) => (api.new_device_by_id)(index),
            }
        };
        if device.is_null() {
            let reason = api.pending_error(std::ptr::null_mut()).unwrap_or_else(|| "no message".to_string());
            return Err(failure(format!("OIDN could not create the {device_name:?} device: {reason}. Pass device \"cpu\" or check the GPU driver.")));
        }
        let mut denoiser = Self {
            api,
            device,
            quality,
            clean_aux: options.clean_aux.unwrap_or(false),
            device_seconds: 0.0,
            key: None,
            filter: std::ptr::null_mut(),
            color_buffer: std::ptr::null_mut(),
            albedo_buffer: std::ptr::null_mut(),
            normal_buffer: std::ptr::null_mut(),
            output_buffer: std::ptr::null_mut(),
        };
        // From here a failure drops `denoiser`, which releases the device.
        if let Some(threads) = options.threads.filter(|count| *count > 0) {
            let setting = name_to_c("numThreads");
            // SAFETY: the device is valid and the name is NUL terminated.
            unsafe { (denoiser.api.set_device_int)(device, setting.as_ptr(), threads as c_int) };
        }
        // SAFETY: the device is valid.
        unsafe { (denoiser.api.commit_device)(device) };
        denoiser.check_device("commit the device")?;
        denoiser.device_seconds = started.elapsed().as_secs_f64();
        Ok(denoiser)
    }

    /// Seconds the constructor spent creating and committing the device (CUDA initialisation is most of it).
    #[napi(getter)]
    pub fn device_seconds(&self) -> f64 {
        self.device_seconds
    }

    #[napi]
    pub fn denoise(&mut self, call: OidnDenoiseCall) -> Result<OidnDenoiseResult> {
        if self.device.is_null() {
            return Err(failure("This OIDN denoiser is closed: create a new one with createOidnDenoiser."));
        }
        let width = call.width as usize;
        let height = call.height as usize;
        if width == 0 || height == 0 {
            return Err(failure("OIDN denoise needs a width and height of at least 1."));
        }
        if width > MAXIMUM_IMAGE_SIDE || height > MAXIMUM_IMAGE_SIDE {
            return Err(failure(format!("OIDN denoise takes a width and height of at most {MAXIMUM_IMAGE_SIDE}; got {width} by {height}.")));
        }
        let floats = width * height * 3;
        if call.normal.is_some() && call.albedo.is_none() {
            return Err(failure("OIDN takes a normal guide only together with an albedo guide: pass albedo too, or drop normal."));
        }
        check_length("color", call.color.len(), floats)?;
        if let Some(albedo) = &call.albedo {
            check_length("albedo", albedo.len(), floats)?;
        }
        if let Some(normal) = &call.normal {
            check_length("normal", normal.len(), floats)?;
        }
        let key = FilterKey { width, height, has_albedo: call.albedo.is_some(), has_normal: call.normal.is_some() };
        let byte_count = floats * 4;

        let commit_started = Instant::now();
        let recommitted = self.key != Some(key);
        if recommitted {
            self.release_session();
            self.build_session(key)?;
        }
        let commit_seconds = if recommitted { commit_started.elapsed().as_secs_f64() } else { 0.0 };

        let write_started = Instant::now();
        // SAFETY: each buffer holds `byte_count` bytes and each source slice was checked to hold as many.
        unsafe {
            (self.api.write_buffer)(self.color_buffer, 0, byte_count, call.color.as_ptr().cast());
            if let Some(albedo) = &call.albedo {
                (self.api.write_buffer)(self.albedo_buffer, 0, byte_count, albedo.as_ptr().cast());
            }
            if let Some(normal) = &call.normal {
                (self.api.write_buffer)(self.normal_buffer, 0, byte_count, normal.as_ptr().cast());
            }
        }
        let write_seconds = write_started.elapsed().as_secs_f64();

        let execute_started = Instant::now();
        // SAFETY: the filter is committed for this key. The sync makes GPU time count here, not in the read.
        unsafe {
            (self.api.execute_filter)(self.filter);
            (self.api.sync_device)(self.device);
        }
        self.check_device("run the filter")?;
        let execute_seconds = execute_started.elapsed().as_secs_f64();

        let read_started = Instant::now();
        let mut denoised = vec![0.0f32; floats];
        // SAFETY: `denoised` holds `byte_count` bytes.
        unsafe { (self.api.read_buffer)(self.output_buffer, 0, byte_count, denoised.as_mut_ptr().cast()) };
        self.check_device("read the result")?;
        let read_seconds = read_started.elapsed().as_secs_f64();

        Ok(OidnDenoiseResult { color: Float32Array::new(denoised), recommitted, commit_seconds, write_seconds, execute_seconds, read_seconds })
    }

    /// Releases the filter, the buffers and the device now instead of when the object is collected.
    #[napi]
    pub fn close(&mut self) {
        self.release_session();
        if !self.device.is_null() {
            // SAFETY: the device is valid and released once.
            unsafe { (self.api.release_device)(self.device) };
            self.device = std::ptr::null_mut();
        }
    }
}

fn check_length(name: &str, actual: usize, expected: usize) -> Result<()> {
    if actual == expected {
        return Ok(());
    }
    Err(failure(format!("OIDN denoise: `{name}` has {actual} floats but the image needs {expected} (3 per pixel): pass a Float32Array of width * height * 3.")))
}

impl OidnDenoiser {
    fn check_device(&self, action: &str) -> Result<()> {
        match self.api.pending_error(self.device) {
            None => Ok(()),
            Some(message) => Err(failure(format!("OIDN could not {action}: {message}."))),
        }
    }

    fn new_buffer(&self, byte_count: usize) -> Result<Handle> {
        // SAFETY: the device is valid.
        let buffer = unsafe { (self.api.new_buffer)(self.device, byte_count) };
        self.check_device("allocate an image buffer")?;
        if buffer.is_null() {
            return Err(failure("OIDN returned no buffer: the device is out of memory for this image size."));
        }
        Ok(buffer)
    }

    fn set_image(&self, name: &str, buffer: Handle, key: FilterKey) {
        let image_name = name_to_c(name);
        // SAFETY: strides of 0 let OIDN compute tightly packed float3 pixels.
        unsafe { (self.api.set_filter_image)(self.filter, image_name.as_ptr(), buffer, FORMAT_FLOAT3, key.width, key.height, 0, 0, 0) };
    }

    /// Allocates the buffers, creates the "RT" filter and commits it. On failure the partly built session is released by
    /// the next `release_session`, which `Drop` and `denoise` both run.
    fn build_session(&mut self, key: FilterKey) -> Result<()> {
        let byte_count = key.width * key.height * BYTES_PER_PIXEL;
        self.color_buffer = self.new_buffer(byte_count)?;
        if key.has_albedo {
            self.albedo_buffer = self.new_buffer(byte_count)?;
        }
        if key.has_normal {
            self.normal_buffer = self.new_buffer(byte_count)?;
        }
        self.output_buffer = self.new_buffer(byte_count)?;
        let filter_type = name_to_c("RT");
        // SAFETY: the device is valid.
        self.filter = unsafe { (self.api.new_filter)(self.device, filter_type.as_ptr()) };
        self.check_device("create the RT filter")?;
        self.set_image("color", self.color_buffer, key);
        if key.has_albedo {
            self.set_image("albedo", self.albedo_buffer, key);
        }
        if key.has_normal {
            self.set_image("normal", self.normal_buffer, key);
        }
        self.set_image("output", self.output_buffer, key);
        let hdr = name_to_c("hdr");
        let clean_aux = name_to_c("cleanAux");
        let quality = name_to_c("quality");
        // SAFETY: the filter is valid and the names are NUL terminated.
        unsafe {
            (self.api.set_filter_bool)(self.filter, hdr.as_ptr(), true);
            (self.api.set_filter_bool)(self.filter, clean_aux.as_ptr(), self.clean_aux);
            (self.api.set_filter_int)(self.filter, quality.as_ptr(), self.quality);
            (self.api.commit_filter)(self.filter);
        }
        self.check_device("commit the RT filter")?;
        self.key = Some(key);
        Ok(())
    }

    fn release_session(&mut self) {
        // SAFETY: each non-null handle came from the matching `new` call and is released once, then nulled.
        unsafe {
            if !self.filter.is_null() {
                (self.api.release_filter)(self.filter);
            }
            for buffer in [self.color_buffer, self.albedo_buffer, self.normal_buffer, self.output_buffer] {
                if !buffer.is_null() {
                    (self.api.release_buffer)(buffer);
                }
            }
        }
        self.filter = std::ptr::null_mut();
        self.color_buffer = std::ptr::null_mut();
        self.albedo_buffer = std::ptr::null_mut();
        self.normal_buffer = std::ptr::null_mut();
        self.output_buffer = std::ptr::null_mut();
        self.key = None;
    }
}

impl Drop for OidnDenoiser {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_names_map_to_types_and_numbers_to_indices() {
        assert_eq!(parse_device("cpu").unwrap(), DeviceChoice::Type(1));
        assert_eq!(parse_device(" CUDA ").unwrap(), DeviceChoice::Type(3));
        assert_eq!(parse_device("2").unwrap(), DeviceChoice::PhysicalIndex(2));
        assert!(parse_device("tpu").is_err());
        assert!(parse_device("-1").is_err());
    }

    #[test]
    fn quality_names_map_to_oidn_values() {
        assert_eq!(parse_quality("high").unwrap(), 6);
        assert_eq!(parse_quality("fast").unwrap(), 4);
        assert!(parse_quality("ultra").is_err());
    }

    #[test]
    fn a_missing_library_names_the_path_and_the_fix() {
        let error = OidnApi::open("definitely-not-an-oidn-library.so").err().expect("opening a missing library fails");
        let message = error.reason.to_string();
        assert!(message.contains("definitely-not-an-oidn-library"));
        assert!(message.contains("npm run fetch"));
    }

    #[test]
    fn image_lengths_are_checked() {
        assert!(check_length("color", 12, 12).is_ok());
        assert!(check_length("color", 11, 12).is_err());
    }
}
