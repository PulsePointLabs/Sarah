# Visual event annotations

Open a manual event with **S** (typed note) or **M** (dictation), then choose **Highlight / measure this frame**. The selected annotation camera is frozen at the note's timestamp. Marking tools and measurements stay in the unsaved note draft until the event is saved. Existing event rows have **Mark frame / measure** or **View / edit visual marks**.

## Tools and comparisons

- Highlight, circle/ellipse and rectangle identify regions. Give each mark a clear label.
- Distance/width uses two clicked endpoints. Angle uses three points; the second is the vertex.
- Sample color uses a dragged rectangular region. It records mean RGB, HSV hue/saturation/value and the sample count. Hue is left undefined in low-saturation regions.
- Set scale uses two endpoints of a known reference in the same plane. Enter its length and units. Without this explicit calibration, distances remain source-image pixels.
- Choose another marked event from the same source camera to compare uniquely matching labels and tools. Results include pixel and percentage distance changes, angle changes, circular hue changes and brightness changes where applicable. The saved comparison retains its reference revision and measured values.

Two-dimensional width is not anatomical circumference. Pose, perspective and camera movement affect apparent distances. Lighting, white balance, exposure and compression affect color. These are reproducible frame measurements, not inferred physiology.

## Review and storage

Selecting an event seeks its marked frame and shows the markings on the matching video camera. Marks follow video zoom/pan and disappear outside the marked moment. Event rows show the measurements; compact Current/Upcoming cards offer the full set in the marking editor. Saved frozen frames can be reopened even before the original video is reloaded.

The original note, categories and other event fields are preserved. The event's `visual_annotation` contains normalized source-image coordinates, source dimensions, camera identity and offset, frame timestamps, a bounded-size JPEG frame, labeled shapes, local measurements, optional calibration and comparison provenance. It also retains a marked JPEG frame. Whole-record JSON exports include this data; no existing CSV columns are changed.

Drawing and measurement run locally. **Ask Sarah about these marks** sends the labeled frame, its unmarked original, the reference frame when selected, and the local measurements to the analysis provider. The response is stored with the markings when applied/saved. Editing the marks invalidates the old response. This action works with existing running servers.

The updated server also includes marked frames and geometry in its existing ±5-second visual-review workflow. A matching reference marked frame is included only if its saved revision still matches. That automatic integration requires the updated server process to be loaded. Drawing alone does not initiate an additional AI request. Use the existing **Review again** action after editing marks on an already reviewed event.

Updated server processes return event/episode count projections without transferring embedded event images. Older running servers fall back to the existing list projection to obtain correct counts. Selected records still load the complete event timeline independently of HR telemetry.
