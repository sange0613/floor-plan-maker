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

function routePath({ start: [x, y], end: [ex, ey], bend, width }) {
  const dx = ex - x
  const dy = ey - y
  const cx = (x + ex) / 2 - dy * bend / 2
  const cy = (y + ey) / 2 + dx * bend / 2
  const angle = Math.atan2(ey - cy, ex - cx)
  const head = Math.min(width * 4, Math.hypot(dx, dy) * 0.45)
  const line = new Path2D()
  line.moveTo(x, y)
  line.quadraticCurveTo(cx, cy, ex, ey)
  const arrow = new Path2D()
  arrow.moveTo(ex - head * Math.cos(angle - Math.PI / 6), ey - head * Math.sin(angle - Math.PI / 6))
  arrow.lineTo(ex, ey)
  arrow.lineTo(ex - head * Math.cos(angle + Math.PI / 6), ey - head * Math.sin(angle + Math.PI / 6))
  return { line, arrow }
}

export function hitRoute(ctx, routes, x, y, tolerance) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const index = routes.findLastIndex(route => {
    const { line, arrow } = routePath(route)
    ctx.lineWidth = route.width + 2 * tolerance
    return ctx.isPointInStroke(line, x, y) || ctx.isPointInStroke(arrow, x, y)
  })
  ctx.restore()
  return index
}

export function drawRoutes(ctx, routes = [], highlighted = -1) {
  ctx.save()
  ctx.strokeStyle = '#303030'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [index, route] of routes.entries()) {
    const { width } = route
    const { line, arrow } = routePath(route)
    ctx.strokeStyle = index === highlighted ? '#1371ab' : '#303030'
    ctx.lineWidth = width
    ctx.setLineDash([width * 3, width * 2])
    ctx.stroke(line)
    ctx.setLineDash([])
    ctx.stroke(arrow)
  }
  ctx.restore()
}
