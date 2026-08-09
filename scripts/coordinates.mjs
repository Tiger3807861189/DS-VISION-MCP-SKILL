export function assertNormalizedBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || box.some((item) => !Number.isFinite(Number(item)))) {
    throw new Error("normalized box must contain four numeric values");
  }
  const value = box.map(Number);
  if (value.some((item) => item < 0 || item > 999) || value[0] >= value[2] || value[1] >= value[3]) {
    throw new Error("normalized box must be ordered within 0..999");
  }
  return value;
}

export function normalizedBoxToPixels(box, width, height) {
  const value = assertNormalizedBox(box);
  assertSize(width, "width");
  assertSize(height, "height");
  return {
    coordinate_status: "image_candidate",
    coordinate_basis: "image_normalized_0_999",
    unit: "normalized_0_999",
    value,
    source_pixel_projection: {
      coordinate_basis: "source_image_pixels",
      unit: "px",
      value: [
      Math.round(value[0] * width / 999),
      Math.round(value[1] * height / 999),
      Math.round(value[2] * width / 999),
      Math.round(value[3] * height / 999),
      ],
    },
  };
}

export function cropPixelsToSource(box, crop) {
  if (!crop || !Number.isFinite(crop.x) || !Number.isFinite(crop.y) || !Number.isFinite(crop.width) || !Number.isFinite(crop.height)) {
    throw new Error("crop requires x, y, width, and height");
  }
  const value = assertPixelBox(box);
  return {
    coordinate_status: "image_candidate",
    coordinate_basis: "source_image_pixels",
    unit: "px",
    value: [value[0] + crop.x, value[1] + crop.y, value[2] + crop.x, value[3] + crop.y],
    transform: "crop_to_source",
  };
}

export function sourcePixelsToViewport(box, manifest) {
  requireFields(manifest, ["source_width", "source_height", "render_width_css", "render_height_css", "viewport_x_css", "viewport_y_css"]);
  const value = assertPixelBox(box);
  const sx = manifest.render_width_css / manifest.source_width;
  const sy = manifest.render_height_css / manifest.source_height;
  return {
    coordinate_status: "runtime_measurement_required",
    coordinate_basis: "viewport_css_pixels",
    unit: "css_px",
    value: [
      manifest.viewport_x_css + value[0] * sx,
      manifest.viewport_y_css + value[1] * sy,
      manifest.viewport_x_css + value[2] * sx,
      manifest.viewport_y_css + value[3] * sy,
    ],
    transform: "source_to_viewport_partial",
    note: "A complete named coordinate chain is required before this becomes a measurable_anchor.",
  };
}

export function viewportToPage(box, manifest) {
  requireFields(manifest, ["scroll_x_css", "scroll_y_css"]);
  const value = assertPixelBox(box);
  return {
    coordinate_status: "runtime_measurement_required",
    coordinate_basis: "page_css_pixels",
    unit: "css_px",
    value: [
      value[0] + manifest.scroll_x_css,
      value[1] + manifest.scroll_y_css,
      value[2] + manifest.scroll_x_css,
      value[3] + manifest.scroll_y_css,
    ],
    transform: "viewport_to_page_partial",
    note: "A complete named coordinate chain is required before this becomes a measurable_anchor.",
  };
}

export function normalizedToMeasurableAnchor(box, chain) {
  assertCoordinateChain(chain);
  const normalized = assertNormalizedBox(box);
  const coordinateImage = chain.coordinate_image;
  const crop = coordinateImage.crop_from_source;
  const coordinatePixels = [
    normalized[0] * coordinateImage.width / 999,
    normalized[1] * coordinateImage.height / 999,
    normalized[2] * coordinateImage.width / 999,
    normalized[3] * coordinateImage.height / 999,
  ];
  const source = coordinatePixels.map((value, index) => value + (index % 2 === 0 ? crop.x : crop.y));
  const sourceRect = chain.render.source_rect;
  const viewport = [
    chain.viewport.x_css + (source[0] - sourceRect.x) * chain.render.css_width / sourceRect.width,
    chain.viewport.y_css + (source[1] - sourceRect.y) * chain.render.css_height / sourceRect.height,
    chain.viewport.x_css + (source[2] - sourceRect.x) * chain.render.css_width / sourceRect.width,
    chain.viewport.y_css + (source[3] - sourceRect.y) * chain.render.css_height / sourceRect.height,
  ];
  const page = [
    viewport[0] + chain.page.scroll_x_css,
    viewport[1] + chain.page.scroll_y_css,
    viewport[2] + chain.page.scroll_x_css,
    viewport[3] + chain.page.scroll_y_css,
  ];
  const coordinate = page.map((value) => Math.round(value * 100) / 100);
  return {
    coordinate_status: "measurable_anchor",
    coordinate_basis: "page_css_pixels",
    unit: "css_px",
    value: coordinate,
    coordinate,
    media_id: chain.media_id,
    coordinate_chain: chain,
  };
}

export function mapToGeometry(pageBox, geometryManifest, targetSpace = "page_css") {
  const value = assertPixelBox(pageBox);
  if (!geometryManifest || !Array.isArray(geometryManifest.targets)) {
    return { status: "unmapped", reason: "geometry_manifest.targets is required" };
  }
  const matches = geometryManifest.targets
    .filter((target) => target.space === targetSpace && Array.isArray(target.rect) && target.rect.length === 4)
    .map((target) => ({ target_id: target.target_id, score: iou(value, target.rect), rect: target.rect }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    status: matches.length ? "candidate_mapping" : "unmapped",
    coordinate_basis: targetSpace,
    candidates: matches,
    note: "Candidates require runtime geometry confirmation and are not source-code locations.",
  };
}

function assertSize(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(field + " must be positive");
}

function assertPixelBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || box.some((item) => !Number.isFinite(Number(item)))) {
    throw new Error("pixel box must contain four numeric values");
  }
  const value = box.map(Number);
  if (value[0] >= value[2] || value[1] >= value[3]) throw new Error("pixel box must be ordered");
  return value;
}

function requireFields(value, fields) {
  if (!value || fields.some((field) => !Number.isFinite(value[field]))) {
    throw new Error("incomplete coordinate transform manifest");
  }
}

function assertCoordinateChain(chain) {
  if (!chain || !chain.media_id || !positiveSize(chain.source_image?.width, chain.source_image?.height) || !positiveSize(chain.coordinate_image?.width, chain.coordinate_image?.height)) {
    throw new Error("complete coordinate chain requires media and source/coordinate image dimensions");
  }
  if (!finiteRect(chain.coordinate_image.crop_from_source) || !finiteRect(chain.render?.source_rect) || !positiveSize(chain.render?.css_width, chain.render?.css_height) || !Number.isFinite(chain.render?.device_pixel_ratio) || chain.render.device_pixel_ratio <= 0) {
    throw new Error("complete coordinate chain requires crop, render source rect, CSS size, and DPR");
  }
  if (!rectWithin(chain.coordinate_image.crop_from_source, chain.source_image) || !rectWithin(chain.render.source_rect, chain.source_image)) {
    throw new Error("complete coordinate chain crop and render source rect must stay within source image");
  }
  if (!Number.isFinite(chain.viewport?.x_css) || !Number.isFinite(chain.viewport?.y_css) || !Number.isFinite(chain.page?.scroll_x_css) || !Number.isFinite(chain.page?.scroll_y_css) || !chain.target_geometry?.manifest_id || !chain.target_geometry?.space) {
    throw new Error("complete coordinate chain requires viewport, page scroll, and target geometry manifest");
  }
  if (chain.target_geometry.space !== "page_css_pixels") {
    throw new Error("complete coordinate chain currently ends in page_css_pixels target geometry");
  }
}

function positiveSize(width, height) {
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
}

function finiteRect(rect) {
  return rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && positiveSize(rect.width, rect.height);
}

function rectWithin(rect, bounds) {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= bounds.width && rect.y + rect.height <= bounds.height;
}

function iou(a, b) {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[2], b[2]);
  const bottom = Math.min(a[3], b[3]);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return intersection / (areaA + areaB - intersection);
}
