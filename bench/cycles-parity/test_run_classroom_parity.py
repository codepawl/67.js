"""Checks for the output stamp of run-classroom-parity.py. Run from the repository root:

  uv run --no-project python -m unittest bench/cycles-parity/test_run_classroom_parity.py
"""
import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
specification = importlib.util.spec_from_file_location("run_classroom_parity", os.path.join(HERE, "run-classroom-parity.py"))
driver = importlib.util.module_from_spec(specification)
specification.loader.exec_module(driver)


class OutputStampTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.code_path = os.path.join(self.directory.name, "bridge.py")
        self.write_code(b"first line\nsecond line\n")
        self.patterns = (self.code_path,)

    def tearDown(self):
        self.directory.cleanup()

    def write_code(self, content):
        with open(self.code_path, "wb") as handle:
            handle.write(content)

    def stamp(self, samples=256, keep_glass=False):
        return driver.inputs_stamp(samples, keep_glass, self.patterns)

    def test_a_matching_stamp_reuses_every_output(self):
        self.assertEqual(driver.stages_forced_by_stale_outputs(self.stamp(), self.stamp()), set())

    def test_a_missing_stamp_runs_the_result_stages_again(self):
        self.assertEqual(driver.stages_forced_by_stale_outputs(None, self.stamp()), {"export", "cook", "cycles", "reference"})

    def test_another_sample_count_or_glass_choice_changes_the_stamp(self):
        self.assertNotEqual(self.stamp(samples=256), self.stamp(samples=1024))
        self.assertNotEqual(self.stamp(keep_glass=False), self.stamp(keep_glass=True))
        self.assertEqual(driver.stages_forced_by_stale_outputs(self.stamp(samples=1024), self.stamp(samples=256)), {"export", "cook", "cycles", "reference"})

    def test_changed_code_changes_the_stamp_and_line_endings_do_not(self):
        before = self.stamp()
        self.write_code(b"first line\r\nsecond line\r\n")
        self.assertEqual(self.stamp(), before)
        self.write_code(b"first line\nsecond line changed\n")
        self.assertNotEqual(self.stamp(), before)


if __name__ == "__main__":
    unittest.main()
