export const clampZoom = (scale, minimum = 0.15) => Math.min(3, Math.max(minimum, scale));
export function zoomAt(view, scale, point, minimum) {
  const next = clampZoom(scale, minimum), ratio = next / view.scale;
  return { scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}
export function fitGraph(layout, width, height) {
  const scale = Math.min(1, Math.max(1, width - 32) / layout.width, Math.max(1, height - 32) / layout.height);
  return { scale, x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2 };
}
