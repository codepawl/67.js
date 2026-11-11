use napi::Result;

use crate::host::device::failure;

const KERNEL_MANIFEST_SOURCE: &str = include_str!("kernel-manifest.txt");

include!(concat!(env!("OUT_DIR"), "/cycles_manifest_files.rs"));

/// Parses `kernel-manifest.txt`, ignoring blank lines and `#` comments, and returns relative WGSL paths in order.
pub(crate) fn parse_kernel_manifest(manifest_text: &str) -> Vec<&str> {
    let mut entries = Vec::new();
    for raw_line in manifest_text.lines() {
        let without_comment = raw_line.split('#').next().unwrap_or("");
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

fn has_compute_main_entry_point(shader_source: &str) -> bool {
    let uncommented = strip_wgsl_comments(shader_source);
    let mut saw_compute_attribute = false;
    for token in uncommented.split_whitespace() {
        if token.contains("@compute") {
            saw_compute_attribute = true;
        }
        if saw_compute_attribute && (token == "main" || token.starts_with("main(")) {
            return true;
        }
    }
    false
}

/// Concatenates the WGSL modules listed in `src/cycles/kernel-manifest.txt` in order and verifies a runnable `@compute`
/// `main` entry point exists before opening a GPU pipeline.
pub(crate) fn assemble_cycles_kernel() -> Result<String> {
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
            .map_err(|error| failure(format!("Cycles kernel module {entry} is not valid UTF-8: {error}")))?;
        if !assembled.is_empty() && !assembled.ends_with('\n') {
            assembled.push('\n');
        }
        assembled.push_str(module_source);
    }
    if !has_compute_main_entry_point(&assembled) {
        return Err(failure(format!(
            "The Cycles native kernel cannot run yet: src/cycles/kernel-manifest.txt defines no @compute main entry point (assembled modules: {}).",
            entries.join(", ")
        )));
    }
    Ok(assembled)
}
