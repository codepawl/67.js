//! The pure rules of a session scene update and of a progressive film (issue 896): what an update may change, what it
//! asks of the acceleration structure, and which samples the next call of a progressive film draws. Nothing here touches
//! the card, so the rules are covered by plain unit tests.

use napi::Result;

use crate::host::accel::{instance_cull_mask, INSTANCE_RECORD_BYTES};
use crate::host::device::failure;

const INSTANCE_TRANSFORM_BYTES: usize = 48;
const INSTANCE_VISIBILITY_FLAGS_BYTE: usize = 116;
/// The fields of an instance record that say which mesh it places. An update keeps them: they decide the BLAS slices.
const INSTANCE_TOPOLOGY_FIELDS: [(&str, usize); 4] = [
    ("blasIndex", 96),
    ("triangleOffset", 100),
    ("opaqueTriangleCount", 104),
    ("totalTriangleCount", 108),
];

/// The scene tables an update can replace, with the position of each in the buffers `upload_cycles_scene_tables` makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UpdatableTable {
    Instances,
    Materials,
    EmissiveTriangles,
    Lights,
    LightTreeNodes,
    LightTreeEmitters,
    LightToTree,
}

impl UpdatableTable {
    /// The index in the scene buffers; keep in step with the order of `upload_cycles_scene_tables`.
    pub(crate) fn buffer_index(self) -> usize {
        match self {
            UpdatableTable::Instances => 0,
            UpdatableTable::Materials => 2,
            UpdatableTable::EmissiveTriangles => 3,
            UpdatableTable::Lights => 4,
            UpdatableTable::LightTreeNodes => 5,
            UpdatableTable::LightTreeEmitters => 9,
            UpdatableTable::LightToTree => 10,
        }
    }

    /// The name the JavaScript input uses for the table.
    pub(crate) fn input_name(self) -> &'static str {
        match self {
            UpdatableTable::Instances => "instances",
            UpdatableTable::Materials => "materials",
            UpdatableTable::EmissiveTriangles => "emissiveTriangles",
            UpdatableTable::Lights => "lights",
            UpdatableTable::LightTreeNodes => "lightTreeNodes",
            UpdatableTable::LightTreeEmitters => "lightTreeEmitters",
            UpdatableTable::LightToTree => "lightToTree",
        }
    }
}

/// What a new instance table asks of the acceleration structure.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InstanceUpdatePlan {
    /// A transform or a ray visibility changed, so the TLAS must be rebuilt (the BLAS are kept).
    pub(crate) tlas_dirty: bool,
    /// How many instances differ from the old table in any byte.
    pub(crate) changed_instances: usize,
}

fn read_word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]])
}

/// Compares a new instance table with the one the session holds. The same instances must stay in the same order with the
/// same meshes; transforms, materials, colours, visibility and light linking may change.
pub(crate) fn plan_instance_update(old_table: &[u8], new_table: &[u8]) -> Result<InstanceUpdatePlan> {
    if old_table.len() != new_table.len() || new_table.len() % INSTANCE_RECORD_BYTES != 0 {
        return Err(failure(format!(
            "The new instance table holds {} bytes but the session holds {}. An update keeps the instance count; create a new session to add or remove instances.",
            new_table.len(),
            old_table.len()
        )));
    }
    let mut tlas_dirty = false;
    let mut changed_instances = 0;
    for (instance_index, (old_record, new_record)) in old_table
        .chunks_exact(INSTANCE_RECORD_BYTES)
        .zip(new_table.chunks_exact(INSTANCE_RECORD_BYTES))
        .enumerate()
    {
        if old_record == new_record {
            continue;
        }
        changed_instances += 1;
        for (field_name, byte_offset) in INSTANCE_TOPOLOGY_FIELDS {
            let old_word = read_word(old_record, byte_offset);
            let new_word = read_word(new_record, byte_offset);
            if old_word != new_word {
                return Err(failure(format!(
                    "Instance {instance_index} changes {field_name} from {old_word} to {new_word}. An update may move or restyle an instance but not change which mesh it places; create a new session for this input."
                )));
            }
        }
        let old_mask = instance_cull_mask(read_word(old_record, INSTANCE_VISIBILITY_FLAGS_BYTE));
        let new_mask = instance_cull_mask(read_word(new_record, INSTANCE_VISIBILITY_FLAGS_BYTE));
        if old_record[..INSTANCE_TRANSFORM_BYTES] != new_record[..INSTANCE_TRANSFORM_BYTES] || old_mask != new_mask {
            tlas_dirty = true;
        }
    }
    Ok(InstanceUpdatePlan { tlas_dirty, changed_instances })
}

/// The bytes of a kernel parameter block that a progressive film compares between calls: everything except the image size
/// and the three words the session writes for each render (sample offset, samples per dispatch, total samples).
const FILM_SIGNATURE_ZEROED_BYTES: std::ops::Range<usize> = 8..28;

pub(crate) fn film_signature(frame_kernel_params: &[u8]) -> Vec<u8> {
    let mut signature = frame_kernel_params.to_vec();
    let zeroed = FILM_SIGNATURE_ZEROED_BYTES.start..FILM_SIGNATURE_ZEROED_BYTES.end.min(signature.len());
    signature[zeroed].fill(0);
    signature
}

/// The film a progressive render is adding to: its size, the sample count it was started for and how many it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProgressiveFilm {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) target_samples: u32,
    pub(crate) samples_drawn: u32,
    pub(crate) signature: Vec<u8>,
}

/// What one render call asks of the film.
pub(crate) struct FilmRequest<'a> {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) samples: u32,
    pub(crate) accumulate: bool,
    pub(crate) target_samples: Option<u32>,
    pub(crate) frame_kernel_params: &'a [u8],
}

/// Which samples a render call draws and into which film.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FilmUse {
    /// The index of the first sample this call draws.
    pub(crate) first_sample: u32,
    /// The value of the kernel's `total_samples` word: the length of each pixel's section of the sample sequence.
    pub(crate) total_samples: u32,
    /// The call starts a new image, so the film is cleared first.
    pub(crate) starts_new_image: bool,
    /// The film this call leaves behind when it succeeds; `None` for a plain frame.
    pub(crate) film_after: Option<ProgressiveFilm>,
}

const REQUIRES_RESET: &str = "Call reset() to start a new image, or render without accumulate.";

/// Decides which samples a call draws. A plain frame draws samples 0..samples of a new image. An accumulating call draws
/// the samples that follow the ones the film holds, in the same sequence a single render of `targetSamples` would use, so
/// the film ends equal to that render. Pure: it changes nothing, so a refused call leaves the film as it was.
pub(crate) fn choose_film_use(film: Option<&ProgressiveFilm>, request: &FilmRequest<'_>) -> Result<FilmUse> {
    if !request.accumulate {
        if request.target_samples.is_some() {
            return Err(failure("targetSamples only applies with accumulate: true. Pass accumulate: true to build one image over several render calls."));
        }
        return Ok(FilmUse { first_sample: 0, total_samples: request.samples, starts_new_image: true, film_after: None });
    }
    let signature = film_signature(request.frame_kernel_params);
    let Some(film) = film else {
        let target_samples = request.target_samples.ok_or_else(|| {
            failure("The first accumulate render of an image needs targetSamples: the total number of samples the image will hold. It fixes the sample sequence, so the calls add up to the same image as one render of that many samples.")
        })?;
        if request.samples > target_samples {
            return Err(failure(format!(
                "samples ({}) is more than targetSamples ({target_samples}). Pass targetSamples as the total for the whole image.",
                request.samples
            )));
        }
        let film_after = ProgressiveFilm {
            width: request.width,
            height: request.height,
            target_samples,
            samples_drawn: request.samples,
            signature,
        };
        return Ok(FilmUse { first_sample: 0, total_samples: target_samples, starts_new_image: true, film_after: Some(film_after) });
    };
    if request.width != film.width || request.height != film.height {
        return Err(failure(format!(
            "The film holds a {}x{} image and this call asks for {}x{}. {REQUIRES_RESET}",
            film.width, film.height, request.width, request.height
        )));
    }
    if let Some(target_samples) = request.target_samples {
        if target_samples != film.target_samples {
            return Err(failure(format!(
                "targetSamples is {target_samples} but the film was started for {}. Leave it out to continue, or call reset() to start an image of another length.",
                film.target_samples
            )));
        }
    }
    if signature != film.signature {
        return Err(failure(format!(
            "The kernel parameters (camera, seed, sampler or other render settings) differ from the ones this film started with, so the new samples would not belong to the same image. {REQUIRES_RESET}"
        )));
    }
    let remaining_samples = film.target_samples - film.samples_drawn;
    if request.samples > remaining_samples {
        return Err(failure(format!(
            "The film holds {} of {} samples; {} more would pass targetSamples. Ask for {remaining_samples} or fewer, or call reset() and start an image with a larger targetSamples.",
            film.samples_drawn, film.target_samples, request.samples
        )));
    }
    let film_after = ProgressiveFilm { samples_drawn: film.samples_drawn + request.samples, ..film.clone() };
    Ok(FilmUse {
        first_sample: film.samples_drawn,
        total_samples: film.target_samples,
        starts_new_image: false,
        film_after: Some(film_after),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance_table(count: usize) -> Vec<u8> {
        let mut table = vec![0u8; count * INSTANCE_RECORD_BYTES];
        for (index, record) in table.chunks_exact_mut(INSTANCE_RECORD_BYTES).enumerate() {
            record[96..100].copy_from_slice(&(index as u32).to_le_bytes());
            record[100..104].copy_from_slice(&(index as u32 * 10).to_le_bytes());
            record[104..108].copy_from_slice(&2u32.to_le_bytes());
            record[108..112].copy_from_slice(&2u32.to_le_bytes());
            record[116..120].copy_from_slice(&0x3Fu32.to_le_bytes());
        }
        table
    }

    #[test]
    fn an_identical_instance_table_changes_nothing() {
        let table = instance_table(3);
        assert_eq!(plan_instance_update(&table, &table.clone()).unwrap(), InstanceUpdatePlan { tlas_dirty: false, changed_instances: 0 });
    }

    #[test]
    fn a_moved_instance_dirties_the_tlas_and_counts_only_itself() {
        let old_table = instance_table(3);
        let mut new_table = old_table.clone();
        new_table[INSTANCE_RECORD_BYTES + 12..INSTANCE_RECORD_BYTES + 16].copy_from_slice(&1.5f32.to_le_bytes());
        let plan = plan_instance_update(&old_table, &new_table).unwrap();
        assert_eq!(plan, InstanceUpdatePlan { tlas_dirty: true, changed_instances: 1 });
    }

    #[test]
    fn a_change_the_hardware_does_not_see_leaves_the_tlas_alone() {
        let old_table = instance_table(2);
        let mut restyled = old_table.clone();
        restyled[112..116].copy_from_slice(&5u32.to_le_bytes()); // material_override
        restyled[144..148].copy_from_slice(&0.5f32.to_le_bytes()); // object_color
        restyled[48..52].copy_from_slice(&2.0f32.to_le_bytes()); // world_to_object row 0 (the shader reads it, the TLAS does not)
        restyled[116..120].copy_from_slice(&(0x3Fu32 | 64).to_le_bytes()); // the negative scale bit is not a ray mask bit
        let plan = plan_instance_update(&old_table, &restyled).unwrap();
        assert_eq!(plan, InstanceUpdatePlan { tlas_dirty: false, changed_instances: 1 });
    }

    #[test]
    fn a_changed_ray_visibility_dirties_the_tlas() {
        let old_table = instance_table(1);
        let mut hidden = old_table.clone();
        hidden[116..120].copy_from_slice(&0x3Eu32.to_le_bytes());
        assert!(plan_instance_update(&old_table, &hidden).unwrap().tlas_dirty);
    }

    #[test]
    fn a_changed_mesh_is_refused_and_the_error_names_the_instance_and_the_field() {
        let old_table = instance_table(3);
        for (field_name, byte_offset) in INSTANCE_TOPOLOGY_FIELDS {
            let mut new_table = old_table.clone();
            let record = 2 * INSTANCE_RECORD_BYTES + byte_offset;
            new_table[record..record + 4].copy_from_slice(&99u32.to_le_bytes());
            let message = plan_instance_update(&old_table, &new_table).unwrap_err().to_string();
            assert!(message.contains("Instance 2"), "{field_name}: {message}");
            assert!(message.contains(field_name), "{field_name}: {message}");
            assert!(message.contains("create a new session"), "{field_name}: {message}");
        }
    }

    #[test]
    fn another_instance_count_is_refused() {
        let message = plan_instance_update(&instance_table(2), &instance_table(3)).unwrap_err().to_string();
        assert!(message.contains("instance count"), "{message}");
        assert!(message.contains("create a new session"), "{message}");
        assert!(plan_instance_update(&[0u8; 100], &[0u8; 100]).is_err());
    }

    #[test]
    fn every_updatable_table_has_its_own_buffer_and_input_name() {
        let tables = [
            UpdatableTable::Instances,
            UpdatableTable::Materials,
            UpdatableTable::EmissiveTriangles,
            UpdatableTable::Lights,
            UpdatableTable::LightTreeNodes,
            UpdatableTable::LightTreeEmitters,
            UpdatableTable::LightToTree,
        ];
        let mut indices: Vec<usize> = tables.iter().map(|table| table.buffer_index()).collect();
        indices.sort_unstable();
        indices.dedup();
        assert_eq!(indices.len(), tables.len());
        assert!(indices.iter().all(|index| *index < 11), "the session holds 11 scene buffers");
        let mut names: Vec<&str> = tables.iter().map(|table| table.input_name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), tables.len());
    }

    fn request<'a>(kernel_params: &'a [u8], samples: u32, accumulate: bool, target_samples: Option<u32>) -> FilmRequest<'a> {
        FilmRequest { width: 24, height: 16, samples, accumulate, target_samples, frame_kernel_params: kernel_params }
    }

    #[test]
    fn a_plain_frame_starts_at_sample_zero_with_its_own_length_and_leaves_no_film() {
        let params = vec![7u8; 320];
        let used = choose_film_use(None, &request(&params, 32, false, None)).unwrap();
        assert_eq!(used, FilmUse { first_sample: 0, total_samples: 32, starts_new_image: true, film_after: None });
        let message = choose_film_use(None, &request(&params, 32, false, Some(64))).unwrap_err().to_string();
        assert!(message.contains("accumulate: true"), "{message}");
    }

    #[test]
    fn split_calls_continue_the_sequence_of_one_render_of_the_target_length() {
        let params = vec![7u8; 320];
        let first = choose_film_use(None, &request(&params, 5, true, Some(16))).unwrap();
        assert_eq!((first.first_sample, first.total_samples, first.starts_new_image), (0, 16, true));
        let second = choose_film_use(first.film_after.as_ref(), &request(&params, 7, true, None)).unwrap();
        assert_eq!((second.first_sample, second.total_samples, second.starts_new_image), (5, 16, false));
        let third = choose_film_use(second.film_after.as_ref(), &request(&params, 4, true, Some(16))).unwrap();
        assert_eq!((third.first_sample, third.total_samples), (12, 16));
        assert_eq!(third.film_after.as_ref().unwrap().samples_drawn, 16);
    }

    #[test]
    fn the_first_accumulating_call_needs_a_target_that_covers_it() {
        let params = vec![7u8; 320];
        let missing = choose_film_use(None, &request(&params, 4, true, None)).unwrap_err().to_string();
        assert!(missing.contains("targetSamples"), "{missing}");
        let too_small = choose_film_use(None, &request(&params, 8, true, Some(4))).unwrap_err().to_string();
        assert!(too_small.contains("more than targetSamples"), "{too_small}");
    }

    #[test]
    fn a_call_that_does_not_belong_to_the_film_is_refused_with_the_way_out() {
        let params = vec![7u8; 320];
        let started = choose_film_use(None, &request(&params, 4, true, Some(8))).unwrap().film_after.unwrap();

        let past_the_end = choose_film_use(Some(&started), &request(&params, 5, true, None)).unwrap_err().to_string();
        assert!(past_the_end.contains("Ask for 4 or fewer"), "{past_the_end}");

        let other_target = choose_film_use(Some(&started), &request(&params, 2, true, Some(12))).unwrap_err().to_string();
        assert!(other_target.contains("reset()"), "{other_target}");

        let mut other_size = request(&params, 2, true, None);
        other_size.width = 25;
        let size_message = choose_film_use(Some(&started), &other_size).unwrap_err().to_string();
        assert!(size_message.contains("24x16") && size_message.contains("25x16"), "{size_message}");

        let mut moved_camera = params.clone();
        moved_camera[200] ^= 1;
        let camera_message = choose_film_use(Some(&started), &request(&moved_camera, 2, true, None)).unwrap_err().to_string();
        assert!(camera_message.contains("kernel parameters"), "{camera_message}");
    }

    #[test]
    fn the_film_signature_ignores_the_words_the_session_writes_for_each_render() {
        let params = vec![7u8; 320];
        let mut rewritten = params.clone();
        rewritten[8..28].copy_from_slice(&[9u8; 20]);
        assert_eq!(film_signature(&params), film_signature(&rewritten));
        let mut other_seed = params.clone();
        other_seed[28] ^= 1;
        assert_ne!(film_signature(&params), film_signature(&other_seed));
    }

    #[test]
    fn a_refused_call_leaves_the_film_as_it_was() {
        let params = vec![7u8; 320];
        let started = choose_film_use(None, &request(&params, 4, true, Some(8))).unwrap().film_after.unwrap();
        let before = started.clone();
        assert!(choose_film_use(Some(&started), &request(&params, 9, true, None)).is_err());
        assert_eq!(started, before);
    }
}
