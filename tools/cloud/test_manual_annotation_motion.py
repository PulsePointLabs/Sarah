import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from manual_annotation_motion import analyze


class TemporalMotionTests(unittest.TestCase):
    def fixture(self, directory, jitter=False, move=True):
        rng = np.random.default_rng(12)
        scene = rng.integers(30, 180, (180, 320, 3), dtype=np.uint8)
        descriptors = []
        for i in range(17):
            frame = scene.copy()
            dx = int(round(4*np.sin(i*np.pi/4))) if move and i <= 8 else 0
            frame[80:130, 40:100] = 60
            frame[85:125, 45+dx:95+dx] = scene[85:125, 45:95]
            if jitter:
                frame = cv2.warpAffine(frame, np.float32([[1,0,i%3], [0,1,i%2]]), (320,180), borderMode=cv2.BORDER_REFLECT)
            name = f'{i}.jpg'
            cv2.imwrite(str(directory/name), frame, [cv2.IMWRITE_JPEG_QUALITY, 98])
            descriptors.append({'filename': name, 'time_s': 67+i/8})
        return descriptors

    def test_subsecond_motion_and_return_detected_despite_identical_one_second_samples(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            frames = self.fixture(directory)
            result = analyze(directory, frames, [{'region':'toes', 'side':'left', 'confidence':'high', 'box':[.12,.44,.2,.3]}, {'region':'foot','side':'right','confidence':'high','box':[.65,.4,.2,.3]}])
            self.assertEqual(result['frame_times_s'], [67+i/8 for i in range(17)])
            self.assertTrue(np.array_equal(cv2.imread(str(directory/'0.jpg')), cv2.imread(str(directory/'8.jpg'))))
            left, right = result['tracks']
            self.assertGreater(max(s.get('motion_p90_px',0) for s in left['samples']), 1)
            self.assertLess(max(s.get('motion_p90_px',0) for s in right['samples']), .25)
            self.assertTrue(left['episodes'])
            self.assertTrue(any(e['direction_changes'] > 0 for e in left['episodes']))
            self.assertEqual(len(result['frame_metrics'][0]['tiles']), 16)

    def test_camera_translation_is_compensated_and_not_called_anatomical_motion(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            result = analyze(directory, self.fixture(directory, jitter=True, move=False), [{'region':'foot', 'side':'unresolved','confidence':'low', 'box':[.12,.44,.2,.3]}])
            self.assertTrue(all(m['camera_compensated'] for m in result['frame_metrics']))
            self.assertLess(max(s.get('motion_p90_px',0) for s in result['tracks'][0]['samples']), .25)
            self.assertEqual(result['tracks'][0]['side'], 'unresolved')

    def test_missing_localization_preserves_full_field_flow_without_inventing_sides(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp)
            result=analyze(directory,self.fixture(directory),[])
            self.assertEqual(result['tracks'],[])
            self.assertFalse(result['frame_metrics'][0]['camera_compensated'])
            self.assertGreater(max(t['p90_px'] for m in result['frame_metrics'] for t in m['tiles']),1)


if __name__ == '__main__':
    unittest.main()
