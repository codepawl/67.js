//! Tests for how a render is split into dispatches. The planner is included by path because the napi library does not
//! link into a test binary.
#![allow(dead_code)]

#[path = "../src/host/dispatch.rs"]
mod dispatch;

use dispatch::{next_tile, DispatchPlanner, TileBudgetPlanner, TileCells, WORKGROUP_PIXELS};

fn batches_for(samples: u32, seconds_per_sample: f64, largest_batch: u32) -> Vec<u32> {
    let mut planner = DispatchPlanner::new(0.5, largest_batch);
    let mut remaining = samples;
    let mut batches = Vec::new();
    while remaining > 0 {
        let batch = planner.next_batch(remaining);
        planner.record(batch, batch as f64 * seconds_per_sample);
        remaining -= batch;
        batches.push(batch);
    }
    batches
}

#[test]
fn the_first_dispatch_draws_one_sample() {
    assert_eq!(DispatchPlanner::new(0.5, 64).next_batch(256), 1);
}

#[test]
fn every_sample_is_drawn_exactly_once() {
    let batches = batches_for(256, 0.02, 256);
    assert_eq!(batches.iter().sum::<u32>(), 256);
}

#[test]
fn a_slow_scene_gets_small_dispatches_that_fit_the_budget() {
    let batches = batches_for(256, 0.1, 256);
    assert!(batches.iter().all(|batch| *batch as f64 * 0.1 <= 0.5 + 1e-9), "{batches:?}");
}

#[test]
fn a_fast_scene_grows_by_a_bounded_factor() {
    let batches = batches_for(256, 0.0001, 256);
    assert_eq!(&batches[..4], &[1, 4, 16, 64]);
}

#[test]
fn a_scene_slower_than_the_budget_still_draws_one_sample_at_a_time() {
    let batches = batches_for(4, 3.0, 4);
    assert_eq!(batches, vec![1, 1, 1, 1]);
}

#[test]
fn the_batch_never_passes_the_largest_allowed() {
    let batches = batches_for(256, 0.0001, 8);
    assert!(batches.iter().all(|batch| *batch <= 8));
}

#[test]
fn a_dispatch_that_turns_slower_shrinks_the_next_one() {
    let mut planner = DispatchPlanner::new(0.5, 256);
    planner.record(1, 0.01);
    assert_eq!(planner.next_batch(256), 4);
    planner.record(4, 2.0);
    assert_eq!(planner.next_batch(256), 1);
}

// ---- Tiles: the budget in two dimensions ----

const BUDGET_SECONDS: f64 = 0.008;

/// Walks one sweep with a fixed cell budget and returns every tile it visits.
fn sweep_tiles(grid_columns: u32, grid_rows: u32, cell_budget: u32) -> Vec<TileCells> {
    let mut cursor = 0;
    let mut tiles = Vec::new();
    while cursor < grid_columns * grid_rows {
        let tile = next_tile(cursor, cell_budget, grid_columns, grid_rows);
        cursor += tile.columns * tile.rows;
        tiles.push(tile);
    }
    tiles
}

fn covered_cells(tiles: &[TileCells], grid_columns: u32, grid_rows: u32) -> Vec<u32> {
    let mut counts = vec![0u32; (grid_columns * grid_rows) as usize];
    for tile in tiles {
        for row in tile.row..tile.row + tile.rows {
            for column in tile.column..tile.column + tile.columns {
                counts[(row * grid_columns + column) as usize] += 1;
            }
        }
    }
    counts
}

#[test]
fn a_sweep_covers_every_cell_exactly_once_for_any_budget() {
    for (columns, rows) in [(1, 1), (7, 5), (60, 34), (240, 135), (13, 1), (1, 9)] {
        for budget in [0, 1, 2, 3, 7, 13, 60, 61, 200, 5000] {
            let tiles = sweep_tiles(columns, rows, budget);
            assert!(
                covered_cells(&tiles, columns, rows).iter().all(|count| *count == 1),
                "{columns}x{rows} cells with a budget of {budget}"
            );
        }
    }
}

#[test]
fn a_tile_is_never_empty_and_never_leaves_the_grid() {
    for budget in [0, 1, 5, 17, 1000] {
        for tile in sweep_tiles(23, 11, budget) {
            assert!(tile.columns >= 1 && tile.rows >= 1);
            assert!(tile.column + tile.columns <= 23 && tile.row + tile.rows <= 11);
        }
    }
}

#[test]
fn a_tile_holds_no_more_cells_than_its_budget_unless_the_budget_is_zero() {
    for budget in [1, 5, 17, 100, 1000] {
        for tile in sweep_tiles(23, 11, budget) {
            assert!(tile.columns * tile.rows <= budget, "{tile:?} against a budget of {budget}");
        }
    }
}

#[test]
fn a_budget_of_whole_rows_gives_full_width_bands() {
    let tiles = sweep_tiles(10, 6, 25);
    assert_eq!(tiles.len(), 3);
    assert!(tiles.iter().all(|tile| tile.columns == 10 && tile.column == 0));
    assert_eq!(tiles.iter().map(|tile| tile.rows).collect::<Vec<_>>(), vec![2, 2, 2]);
}

#[test]
fn a_tile_at_the_edge_counts_only_the_pixels_inside_the_image() {
    // A 20 x 13 pixel image: 3 x 2 cells; the last column holds 4 pixels across, the last row 5 pixels down.
    let tiles = sweep_tiles(3, 2, 1);
    let counts: Vec<u64> = tiles.iter().map(|tile| tile.pixel_count(20, 13)).collect();
    assert_eq!(counts, vec![64, 64, 32, 40, 40, 20]);
    assert_eq!(counts.iter().sum::<u64>(), 20 * 13);
}

#[test]
fn a_tile_origin_is_a_multiple_of_the_workgroup_size() {
    for tile in sweep_tiles(9, 4, 4) {
        let (x, y) = tile.origin_pixels();
        assert_eq!((x % WORKGROUP_PIXELS, y % WORKGROUP_PIXELS), (0, 0));
    }
}

/// Plays a whole render against a cost model: a dispatch of `work` pixel samples takes `overhead + work * seconds_per_work`.
/// Returns the seconds and the (pixel samples) of every dispatch, and checks every pixel gets every sample once.
fn play_render(width: u32, height: u32, samples: u32, overhead: f64, seconds_per_work: f64, largest_batch: u32) -> Vec<(f64, u64)> {
    let mut planner = TileBudgetPlanner::new(BUDGET_SECONDS, width, height, largest_batch);
    let (columns, rows) = planner.grid();
    let mut drawn = vec![0u32; (width * height) as usize];
    let mut dispatches = Vec::new();
    let mut sample_offset = 0;
    while sample_offset < samples {
        let batch = planner.sweep_samples(samples - sample_offset);
        assert!(batch >= 1 && batch <= samples - sample_offset && batch <= largest_batch);
        let mut cursor = 0;
        while cursor < planner.cell_count() {
            let tile = next_tile(cursor, planner.cell_budget(batch), columns, rows);
            cursor += tile.columns * tile.rows;
            let (origin_x, origin_y) = tile.origin_pixels();
            for y in origin_y..(origin_y + tile.rows * WORKGROUP_PIXELS).min(height) {
                for x in origin_x..(origin_x + tile.columns * WORKGROUP_PIXELS).min(width) {
                    drawn[(y * width + x) as usize] += batch;
                }
            }
            let work = tile.pixel_count(width, height) * batch as u64;
            let seconds = overhead + work as f64 * seconds_per_work;
            planner.record(work, seconds);
            dispatches.push((seconds, work));
        }
        sample_offset += batch;
    }
    assert!(drawn.iter().all(|count| *count == samples), "every pixel gets every sample once");
    dispatches
}

#[test]
fn every_pixel_sample_is_drawn_once_for_sizes_that_do_not_divide_by_the_tile() {
    for (width, height) in [(1, 1), (7, 3), (33, 17), (100, 100), (129, 65)] {
        play_render(width, height, 9, 0.0001, 2e-8, 9);
    }
}

#[test]
fn the_first_dispatch_is_one_workgroup_and_one_sample() {
    let dispatches = play_render(480, 270, 4, 0.0001, 5e-8, 4);
    assert_eq!(dispatches[0].1, 64);
}

#[test]
fn a_slow_scene_stays_inside_the_budget_after_the_ramp_up() {
    // 1920 x 1080 at 0.4 microseconds a pixel sample: a whole-image sample takes 0.83 s.
    let dispatches = play_render(1920, 1080, 4, 0.0002, 4e-7, 4);
    let steady: Vec<_> = dispatches.iter().skip(12).collect();
    assert!(!steady.is_empty());
    assert!(steady.iter().all(|(seconds, _)| *seconds <= BUDGET_SECONDS * 1.05), "{steady:?}");
}

#[test]
fn a_fast_scene_draws_several_samples_of_the_whole_image_in_one_dispatch() {
    // 64 x 64 at 1e-9 s a pixel sample: 64 samples of the image cost 0.26 ms, far under the budget.
    let dispatches = play_render(64, 64, 64, 0.0, 1e-9, 64);
    assert!(dispatches.len() < 20, "{} dispatches", dispatches.len());
    assert!(dispatches.last().unwrap().1 > 4096);
}

#[test]
fn the_samples_of_a_dispatch_never_pass_the_largest_batch() {
    let dispatches = play_render(32, 32, 40, 0.0, 1e-10, 3);
    assert!(dispatches.iter().all(|(_, work)| *work <= 32 * 32 * 3));
}

#[test]
fn a_scene_slower_than_the_budget_per_workgroup_still_makes_progress() {
    // One workgroup of 64 pixel samples takes 0.1 s, far over the 8 ms budget: tiles stay one workgroup, never zero.
    let dispatches = play_render(24, 16, 2, 0.0, 0.1 / 64.0, 2);
    assert_eq!(dispatches.len(), 6 * 2);
    assert!(dispatches.iter().all(|(_, work)| *work <= 64));
}

#[test]
fn an_expensive_region_after_cheap_tiles_does_not_get_a_dispatch_sized_for_the_cheap_ones() {
    let mut planner = TileBudgetPlanner::new(BUDGET_SECONDS, 1920, 1080, 1);
    planner.record(100_000, 0.004);
    planner.record(200_000, 0.0001);
    let cheap_allowed = planner.cell_budget(1);
    let mut cautious = TileBudgetPlanner::new(BUDGET_SECONDS, 1920, 1080, 1);
    cautious.record(200_000, 0.0001);
    assert!(cheap_allowed < cautious.cell_budget(1), "the peak cost of the first tile limits the next ones");
}
