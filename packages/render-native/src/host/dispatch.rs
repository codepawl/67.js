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

/// The side in pixels of the square one workgroup covers (`@workgroup_size(8, 8, 1)` in integrator.wgsl). A tile is a
/// rectangle of whole workgroups ("cells"), so its origin and size are multiples of this.
pub(crate) const WORKGROUP_PIXELS: u32 = 8;

const PIXELS_PER_CELL: u64 = (WORKGROUP_PIXELS as u64) * (WORKGROUP_PIXELS as u64);

/// A dispatch whose measured time is at least this share of the budget is long enough that the fixed cost of a submission
/// hardly shows in it, so its cost per pixel sample counts as a peak that later, differently priced tiles must respect.
const PEAK_COST_MINIMUM_BUDGET_SHARE: f64 = 0.25;

/// The planned size of the next dispatch may not fall below this share of the slowest cost per pixel sample seen, so a run
/// of cheap tiles (sky) does not lead to a dispatch over expensive ones (geometry) that overruns the budget.
const PEAK_COST_FLOOR_SHARE: f64 = 0.5;

/// A rectangle of workgroups on the grid that covers the image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TileCells {
    pub(crate) column: u32,
    pub(crate) row: u32,
    pub(crate) columns: u32,
    pub(crate) rows: u32,
}

impl TileCells {
    /// The pixel position of the tile's top left corner.
    pub(crate) fn origin_pixels(&self) -> (u32, u32) {
        (self.column * WORKGROUP_PIXELS, self.row * WORKGROUP_PIXELS)
    }

    /// The pixels of the tile that lie inside a `width` x `height` image; the cells at the right and bottom edges may hang over.
    pub(crate) fn pixel_count(&self, width: u32, height: u32) -> u64 {
        let (origin_x, origin_y) = self.origin_pixels();
        let covered_width = (self.columns * WORKGROUP_PIXELS).min(width.saturating_sub(origin_x));
        let covered_height = (self.rows * WORKGROUP_PIXELS).min(height.saturating_sub(origin_y));
        covered_width as u64 * covered_height as u64
    }
}

/// The tile that starts at cell number `cursor` (row by row from the top left) and holds about `cell_budget` cells, never
/// zero. Full rows when the budget is at least one row, else a part of one row, so a walk from cell 0 that advances by
/// `columns * rows` covers every cell exactly once.
pub(crate) fn next_tile(cursor: u32, cell_budget: u32, grid_columns: u32, grid_rows: u32) -> TileCells {
    let column = cursor % grid_columns;
    let row = cursor / grid_columns;
    let budget = cell_budget.max(1);
    if column != 0 || budget < grid_columns {
        let columns = budget.min(grid_columns - column);
        return TileCells { column, row, columns, rows: 1 };
    }
    let rows = (budget / grid_columns).min(grid_rows - row);
    TileCells { column: 0, row, columns: grid_columns, rows }
}

/// Chooses the samples and the pixel tile of each dispatch from the measured time of the earlier ones, so that no dispatch
/// holds the GPU queue longer than the budget and a display on the same GPU can draw between them.
///
/// A sweep covers the whole image with the same samples; the samples of a pixel are drawn in order across sweeps, which is
/// what keeps the film byte-identical to a whole-image dispatch. While one dispatch cannot cover the image in the budget a
/// sweep draws a single sample, tile by tile; once it can, a dispatch covers the image and grows in samples.
pub(crate) struct TileBudgetPlanner {
    budget_seconds: f64,
    grid_columns: u32,
    grid_rows: u32,
    image_pixels: u64,
    largest_batch: u32,
    /// The pixel samples (pixels times samples) the next dispatch may hold.
    allowed_work: u64,
    slowest_seconds_per_work: f64,
}

impl TileBudgetPlanner {
    /// Starts at one workgroup and one sample, the smallest dispatch, to measure the cost of a pixel sample.
    pub(crate) fn new(budget_seconds: f64, width: u32, height: u32, largest_batch: u32) -> Self {
        Self {
            budget_seconds,
            grid_columns: width.div_ceil(WORKGROUP_PIXELS).max(1),
            grid_rows: height.div_ceil(WORKGROUP_PIXELS).max(1),
            image_pixels: (width as u64 * height as u64).max(1),
            largest_batch: largest_batch.max(1),
            allowed_work: PIXELS_PER_CELL,
            slowest_seconds_per_work: 0.0,
        }
    }

    pub(crate) fn grid(&self) -> (u32, u32) {
        (self.grid_columns, self.grid_rows)
    }

    pub(crate) fn cell_count(&self) -> u32 {
        self.grid_columns * self.grid_rows
    }

    /// The samples every dispatch of the sweep that starts now draws, never more than `remaining_samples`.
    pub(crate) fn sweep_samples(&self, remaining_samples: u32) -> u32 {
        let whole_image_batches = (self.allowed_work / self.image_pixels).min(self.largest_batch as u64) as u32;
        whole_image_batches.min(remaining_samples).max(1)
    }

    /// The cells the next tile of a sweep of `samples` samples may hold; at least one.
    pub(crate) fn cell_budget(&self, samples: u32) -> u32 {
        let sweep_work = samples.max(1) as u64;
        if sweep_work * self.image_pixels <= self.allowed_work {
            return self.cell_count();
        }
        let cells = self.allowed_work / (sweep_work * PIXELS_PER_CELL);
        cells.clamp(1, self.cell_count() as u64) as u32
    }

    /// Records that a dispatch of `work` pixel samples took `seconds` and sizes the next one to fit the budget.
    pub(crate) fn record(&mut self, work: u64, seconds: f64) {
        let work = work.max(1);
        let seconds_per_work = (seconds / work as f64).max(1e-12);
        if seconds >= self.budget_seconds * PEAK_COST_MINIMUM_BUDGET_SHARE {
            self.slowest_seconds_per_work = self.slowest_seconds_per_work.max(seconds_per_work);
        }
        let planning_cost = seconds_per_work.max(self.slowest_seconds_per_work * PEAK_COST_FLOOR_SHARE);
        let fitting_work = (self.budget_seconds / planning_cost).min(u64::MAX as f64) as u64;
        let growth_ceiling = work.saturating_mul(BATCH_GROWTH_LIMIT as u64);
        let largest_work = self.image_pixels.saturating_mul(self.largest_batch as u64);
        self.allowed_work = fitting_work.min(growth_ceiling).min(largest_work).max(PIXELS_PER_CELL);
    }
}
