//! Tests for how a render is split into dispatches. The planner is included by path because the napi library does not
//! link into a test binary.
#![allow(dead_code)]

#[path = "../src/host/dispatch.rs"]
mod dispatch;

use dispatch::DispatchPlanner;

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
