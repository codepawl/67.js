//! How a render is split into GPU dispatches. A driver resets the device when one dispatch runs for more than a couple of
//! seconds (the Windows timeout is 2 s), so the render is cut into dispatches that each stay under a time budget.

/// The longest one dispatch should run. Well under the 2 s driver timeout, long enough that the wait between dispatches is noise.
pub(crate) const DISPATCH_BUDGET_SECONDS: f64 = 0.5;

/// A batch grows by at most this factor per dispatch, so one fast first measurement cannot jump to a dispatch that is too long.
const BATCH_GROWTH_LIMIT: u32 = 4;

/// Chooses how many samples the next dispatch draws from the measured time of the last one.
/// The first dispatch draws a single sample to measure the cost of one.
pub(crate) struct DispatchPlanner {
    budget_seconds: f64,
    largest_batch: u32,
    next_batch: u32,
}

impl DispatchPlanner {
    pub(crate) fn new(budget_seconds: f64, largest_batch: u32) -> Self {
        Self { budget_seconds, largest_batch: largest_batch.max(1), next_batch: 1 }
    }

    /// The samples to draw now, never more than `remaining_samples`.
    pub(crate) fn next_batch(&self, remaining_samples: u32) -> u32 {
        self.next_batch.min(remaining_samples).max(1)
    }

    /// Records that `batch_samples` took `seconds` and sizes the next batch to fit the budget.
    pub(crate) fn record(&mut self, batch_samples: u32, seconds: f64) {
        let seconds_per_sample = (seconds / batch_samples.max(1) as f64).max(1e-9);
        let fitting_samples = (self.budget_seconds / seconds_per_sample).min(u32::MAX as f64) as u32;
        let growth_ceiling = batch_samples.saturating_mul(BATCH_GROWTH_LIMIT).min(self.largest_batch);
        self.next_batch = fitting_samples.clamp(1, growth_ceiling.max(1));
    }
}
