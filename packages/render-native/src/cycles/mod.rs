use napi::Result;

use crate::host::device::failure;

const KERNEL_MANIFEST_SOURCE: &str = include_str!("kernel-manifest.txt");
const BOOTSTRAP_MAIN_SOURCE: &str = include_str!("bootstrap_main.wgsl");

include!(concat!(env!("OUT_DIR"), "/cycles_manifest_files.rs"));

/// Parses `kernel-manifest.txt`, stripping any UTF-8 BOM and ignoring blank lines and `#` comments, and returns relative WGSL paths in order.
pub(crate) fn parse_kernel_manifest(manifest_text: &str) -> Vec<&str> {
    let mut entries = Vec::new();
    let without_file_bom = manifest_text.trim_start_matches('\u{feff}');
    for raw_line in without_file_bom.lines() {
        let without_line_bom = raw_line.trim_start_matches('\u{feff}');
        let without_comment = without_line_bom.split('#').next().unwrap_or("");
        let trimmed = without_comment.trim();
        if !trimmed.is_empty() {
            entries.push(trimmed);
        }
    }
    entries
}

fn strip_wgsl_comments(source: &str) -> String {
    let mut cleaned = String::with_capacity(source.len());
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut block_depth = 0usize;
    while index < bytes.len() {
        if block_depth > 0 {
            if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
                block_depth += 1;
                index += 2;
                continue;
            }
            if index + 1 < bytes.len() && bytes[index] == b'*' && bytes[index + 1] == b'/' {
                block_depth -= 1;
                index += 2;
                cleaned.push(' ');
                continue;
            }
            if bytes[index] == b'\n' {
                cleaned.push('\n');
            }
            index += 1;
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'/' {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            block_depth = 1;
            index += 2;
            continue;
        }
        cleaned.push(bytes[index] as char);
        index += 1;
    }
    cleaned
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

pub(crate) fn has_compute_entry_point(shader_source: &str, target_entry_point: &str) -> bool {
    let uncommented = strip_wgsl_comments(shader_source);
    let bytes = uncommented.as_bytes();
    let mut index = 0usize;
    let mut pending_compute = false;
    let mut awaiting_function_name = false;
    while index < bytes.len() {
        if bytes[index] == b'@' {
            let start = index + 1;
            let mut end = start;
            while end < bytes.len() && is_identifier_byte(bytes[end]) {
                end += 1;
            }
            if &uncommented[start..end] == "compute" {
                pending_compute = true;
            }
            index = end;
            continue;
        }
        if is_identifier_byte(bytes[index]) {
            let start = index;
            let mut end = start + 1;
            while end < bytes.len() && is_identifier_byte(bytes[end]) {
                end += 1;
            }
            let token = &uncommented[start..end];
            if awaiting_function_name {
                if pending_compute && token == target_entry_point {
                    return true;
                }
                awaiting_function_name = false;
                pending_compute = false;
            } else if token == "fn" {
                awaiting_function_name = true;
            }
            index = end;
            continue;
        }
        index += 1;
    }
    false
}

/// Concatenates the WGSL modules listed in `src/cycles/kernel-manifest.txt` in order and verifies a runnable `@compute`
/// `target_entry_point` exists (appending `bootstrap_main.wgsl` only when `allow_bootstrap` is true and the manifest lacks it).
pub(crate) fn assemble_cycles_kernel_entry(target_entry_point: &str, allow_bootstrap: bool) -> Result<String> {
    let entries = parse_kernel_manifest(KERNEL_MANIFEST_SOURCE);
    if entries.is_empty() {
        return Err(failure(
            "The Cycles native kernel cannot run: src/cycles/kernel-manifest.txt lists no WGSL files.",
        ));
    }
    let mut assembled = String::new();
    for entry in &entries {
        let (_, raw_bytes) = CYCLES_MANIFEST_FILES
            .iter()
            .find(|(name, _)| name == entry)
            .ok_or_else(|| failure(format!("Cycles kernel manifest entry is not embedded: {entry}")))?;
        let module_source = std::str::from_utf8(raw_bytes)
            .map_err(|error| failure(format!("Cycles kernel module {entry} is not valid UTF-8: {error}")))?
            .trim_start_matches('\u{feff}');
        if !assembled.is_empty() && !assembled.ends_with('\n') {
            assembled.push('\n');
        }
        assembled.push_str(module_source);
    }
    if !has_compute_entry_point(&assembled, target_entry_point) {
        if allow_bootstrap {
            if !assembled.ends_with('\n') {
                assembled.push('\n');
            }
            assembled.push_str(BOOTSTRAP_MAIN_SOURCE.trim_start_matches('\u{feff}'));
        }
        if !has_compute_entry_point(&assembled, target_entry_point) {
            return Err(failure(format!(
                "The Cycles native kernel cannot run yet: src/cycles/kernel-manifest.txt defines no @compute {target_entry_point} entry point (assembled modules: {}).",
                entries.join(", ")
            )));
        }
    }
    Ok(assembled)
}

pub(crate) fn assemble_cycles_kernel() -> Result<String> {
    assemble_cycles_kernel_entry("main", false)
}

#[cfg(test)]
mod tests {
    use super::{has_compute_entry_point, parse_kernel_manifest};

    #[test]
    fn parses_manifest_with_utf8_bom_and_comments() {
        let text = "\u{feff}# header\r\n\u{feff}abi.wgsl # inline comment\r\n  closure.wgsl \n\n";
        assert_eq!(parse_kernel_manifest(text), vec!["abi.wgsl", "closure.wgsl"]);
    }

    #[test]
    fn detects_named_compute_entry_points_independently() {
        let source = r#"
            // @compute fn main() {}
            fn helper() {}
            @compute @workgroup_size(64, 1, 1)
            fn test_lobe_samples() {}
            fn not_compute_main() {}
        "#;
        assert!(has_compute_entry_point(source, "test_lobe_samples"));
        assert!(!has_compute_entry_point(source, "main"));
        assert!(!has_compute_entry_point(source, "helper"));
    }
}
