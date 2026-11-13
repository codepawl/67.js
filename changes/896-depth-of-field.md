- A camera with an `fStop` now renders with depth of field in the native path tracer's `cycles` kernel, with Cycles' thin lens (round or polygonal aperture, focus distance along the view axis), and a pinhole camera renders the same pixels as before (#896)
  media: /previews/feature-cook-dof.webp The native path tracer focusing from a red sphere in front to a gold and a purple sphere behind it
