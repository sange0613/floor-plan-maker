export function transformRoutes(routes = [], transform) {
  return routes.map(route => ({ ...route, start: transform(route.start), end: transform(route.end) }))
}

export function readRoutes(value) {
  const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  if (!Array.isArray(value)) return []
  return value.filter(route => route && point(route.start) && point(route.end)).map(route => ({
    start: route.start, end: route.end,
    bend: Number.isFinite(route.bend) ? Math.max(-1, Math.min(1, route.bend)) : 0,
    width: Number.isFinite(route.width) ? Math.max(1, Math.min(50, route.width)) : 3,
  }))
}

export function drawRoutes(ctx, routes = []) {
  ctx.save()
  ctx.strokeStyle = '#303030'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const { start: [x, y], end: [ex, ey], bend, width } of routes) {
    const dx = ex - x
    const dy = ey - y
    const cx = (x + ex) / 2 - dy * bend / 2
    const cy = (y + ey) / 2 + dx * bend / 2
    const angle = Math.atan2(ey - cy, ex - cx)
    const head = Math.min(width * 4, Math.hypot(dx, dy) * 0.45)
    ctx.lineWidth = width
    ctx.setLineDash([width * 3, width * 2])
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(cx, cy, ex, ey)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(ex - head * Math.cos(angle - Math.PI / 6), ey - head * Math.sin(angle - Math.PI / 6))
    ctx.lineTo(ex, ey)
    ctx.lineTo(ex - head * Math.cos(angle + Math.PI / 6), ey - head * Math.sin(angle + Math.PI / 6))
    ctx.stroke()
  }
  ctx.restore()
}
