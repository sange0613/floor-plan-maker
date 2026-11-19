import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { analyzeRegions, countClosedRegions, createLineMask, findClosedRegion, hexToRgb } from '../lib/canvasEngine'
import { createMaterialState, cloneMaterialState, paintRegion, editMaterial, deleteMaterial, materialName, normalizeMaterial, encodeAssignments, decodeAssignments, migrateLegacyFill, transformMaterials, materialBasePixels, setColorShadows } from '../lib/materials'
import { renderMaterialFill } from '../lib/materialPatterns'
import { drawArtworkLayers } from '../lib/compositeLayers'
import { rotatePlane } from '../lib/rotatePlane'
import { drawRoutes, hitRoute, readRoutes, transformRoutes } from '../lib/routes'

const loadDataImage = (url) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = reject
  image.src = url
})

// Clean-room Canvas equivalent of the plugin's progressive step distribution.
const distributeByFactor = (range, slices, factor, addUp) => {
  const count = Math.max(1, Math.round(slices || 1))
  const scale = Math.max(1, Number(factor) || 1)
  const parts = []
  if (scale === 1) {
    const part = range / count
    for (let index = 1; index <= count; index += 1) parts.push(addUp ? index * part : part)
    return parts
  }
  const startValue = range * Math.abs(scale - 1) / (Math.pow(scale, count) - 1)
  let increasingFactor = scale
  let previousPart = startValue
  parts.push(Math.ceil(startValue))
  for (let index = 1; index < count; index += 1) {
    let nextPart = startValue * increasingFactor
    if (addUp) {
      nextPart += previousPart
      previousPart = nextPart
    }
    parts.push(Math.ceil(nextPart))
    increasingFactor *= scale
  }
  return parts
}

const EditorCanvas = forwardRef(function EditorCanvas(
  {
    source, tool, fillColor, activeMaterial, onMaterialStateChange = () => {}, onSelectionChange = () => {}, busy, lineColor, lineOpacity, linePosition = 'top', sensitivity, gapSize, hoverPreview, background, backgroundOpacity,
    fillLayerOpacities, fillLayerVisibility, fillLayerShadows, zoom, cropRequest, onRegions, onLayersChange, onMessage,
    onBusy, onCanvasSize, onCropApplied, onCropCancel, onHistoryChange, onRoutesChange, onRouteSelect, snapRoute,
  },
  ref,
) {
  const canvasRef = useRef(null)
  const routeCanvasRef = useRef(null)
  const routeDragRef = useRef(null)
  const hoverCanvasRef = useRef(null)
  const sourceRef = useRef(null)
  const cropStartRef = useRef(null)
  const hoverFrameRef = useRef(null)
  const lastHoverSeedRef = useRef(-1)
  const selectionRef = useRef(null)
  const interactionRef = useRef(null)
  const timelineRef = useRef({ entries: [], index: -1, sequence: 0 })
  const [cropSelection, setCropSelection] = useState(null)
  const [routeStart, setRouteStart] = useState(null)
  useEffect(() => { setRouteStart(null) }, [tool, source])
  const engineRef = useRef({
    mask: null, lineAlpha: null, fill: null, displayFill: null, width: 0, height: 0,
    history: [], fillCanvas: null, lineCanvas: null, hoverCanvas: null, hoverBounds: null,
    layerCounts: new Map(), layerOrder: [], regions: 0,
  })

  const emitLayers = () => {
    const engine = engineRef.current
    if (!engine.materialState) return
    const layers = engine.layerOrder.filter(id => engine.layerCounts.get(String(id)) > 0)
      .map(id => ({ ...engine.materialState.materials[id], id: Number(id), name: materialName(engine.materialState.materials[id]), regionCount: engine.layerCounts.get(String(id)) }))
    onMaterialStateChange(layers)
    onLayersChange(layers)
  }

  const selectRegion = (seed) => {
    const engine = engineRef.current
    const materialId = seed == null ? null : engine.materialState.assignments[seed]
    selectionRef.current = seed == null ? null : { seed, materialId }
    onSelectionChange(selectionRef.current)
  }

  const refreshLayerCounts = () => {
    const engine = engineRef.current
    const analysis = analyzeRegions(engine.mask, engine.width, engine.height, null, pixel => engine.materialState.assignments[pixel])
    engine.layerCounts = analysis.layerCounts
    engine.layerOrder = [...new Set([...engine.layerOrder, ...analysis.layerCounts.keys()])].filter((color) => analysis.layerCounts.has(color))
    emitLayers()
  }

  const emitHistory = () => {
    const timeline = timelineRef.current
    onHistoryChange(timeline.entries.map(({ id, label, time }) => ({ id, label, time })), timeline.entries[timeline.index]?.id)
    onRoutesChange(engineRef.current.routes || [], engineRef.current.routesVisible !== false)
  }

  const recordHistory = (label, reset = false) => {
    const engine = engineRef.current
    if (!engine.fill || !sourceRef.current) return
    const timeline = timelineRef.current
    if (reset) {
      timeline.entries = []
      timeline.index = -1
    } else if (timeline.index < timeline.entries.length - 1) {
      timeline.entries = timeline.entries.slice(0, timeline.index + 1)
    }
    timeline.sequence += 1
    timeline.entries.push({
      id: timeline.sequence,
      label,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      sourceCanvas: sourceRef.current,
      mask: engine.mask,
      lineAlpha: engine.lineAlpha,
      materialState: { assignments: encodeAssignments(engine.materialState.assignments), materials: structuredClone(engine.materialState.materials), nextId: engine.materialState.nextId },
      width: engine.width,
      height: engine.height,
      layerCounts: new Map(engine.layerCounts),
      layerOrder: [...engine.layerOrder],
      regions: engine.regions,
      routes: engine.routes,
      routesVisible: engine.routesVisible,
    })
    // One initial state plus 100 undoable edits.
    const maxEntries = 101
    if (timeline.entries.length > maxEntries) timeline.entries.splice(0, timeline.entries.length - maxEntries)
    timeline.index = timeline.entries.length - 1
    emitHistory()
  }

  const endMaterialInteraction = () => {
    const interaction = interactionRef.current
    interactionRef.current = null
    if (interaction?.changed) recordHistory(interaction.label)
  }

  const renderRoutes = (routes = engineRef.current.routes, highlighted = -1) => {
    const canvas = routeCanvasRef.current
    const engine = engineRef.current
    if (canvas.width !== engine.width) canvas.width = engine.width
    if (canvas.height !== engine.height) canvas.height = engine.height
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (engine.routesVisible !== false) drawRoutes(ctx, routes, highlighted)
  }

  useEffect(() => {
    if (tool !== 'route-move' && routeDragRef.current) {
      routeDragRef.current = null
      renderRoutes()
    }
  }, [tool])

  const render = () => {
    const canvas = canvasRef.current
    const engine = engineRef.current
    if (!canvas || !engine.mask) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    if (background) {
      const scale = Math.max(canvas.width / background.width, canvas.height / background.height)
      const width = background.width * scale
      const height = background.height * scale
      ctx.save()
      ctx.globalAlpha = backgroundOpacity / 100
      ctx.drawImage(background, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
      ctx.restore()
    }

    const fillContext = engine.fillCanvas.getContext('2d')
    const materialMasks = renderMaterialFill(fillContext, engine.materialState, canvas.width, canvas.height)
    const shadowMasks = new Map([...materialMasks].filter(([id]) => engine.materialState.materials[id].shadow && engine.materialState.materials[id].shadow.enabled !== false)
      .map(([id, image]) => [id, { image, shadow: engine.materialState.materials[id].shadow }]))
    if (!engine.shadowMaskCanvas || engine.shadowMaskCanvas.width !== canvas.width || engine.shadowMaskCanvas.height !== canvas.height) {
      engine.shadowMaskCanvas = document.createElement('canvas')
      engine.shadowLayerCanvas = document.createElement('canvas')
      engine.shadowCompositeCanvas = document.createElement('canvas')
      for (const shadowCanvas of [engine.shadowMaskCanvas, engine.shadowLayerCanvas, engine.shadowCompositeCanvas]) {
        shadowCanvas.width = canvas.width
        shadowCanvas.height = canvas.height
      }
    }
    const maskContext = engine.shadowMaskCanvas.getContext('2d')
    const shadowContext = engine.shadowLayerCanvas.getContext('2d')
    const compositeContext = engine.shadowCompositeCanvas.getContext('2d')
    compositeContext.clearRect(0, 0, canvas.width, canvas.height)
    shadowMasks.forEach(({ shadow, image }, materialId) => {
      const angle = (Number(shadow.angle ?? 33) * Math.PI) / 180
      const steps = Math.max(1, Math.min(30, Number(shadow.steps ?? 20)))
      const stepScale = Math.max(1, Number(shadow.stepScale ?? 1.3))
      const distanceSteps = distributeByFactor(Number(shadow.distance ?? 35), steps, stepScale, true)
      const blurSteps = distributeByFactor(Number(shadow.blur ?? 4), steps, stepScale, true)
      maskContext.clearRect(0, 0, canvas.width, canvas.height)
      maskContext.putImageData(image, 0, 0)
      shadowContext.clearRect(0, 0, canvas.width, canvas.height)
      distanceSteps.forEach((distance, index) => {
        shadowContext.save()
        shadowContext.filter = blurSteps[index] > 0 ? `blur(${blurSteps[index]}px)` : 'none'
        shadowContext.drawImage(
          engine.shadowMaskCanvas,
          Math.round(Math.cos(angle) * distance),
          Math.round(Math.sin(angle) * distance),
        )
        shadowContext.restore()
      })
      shadowContext.save()
      shadowContext.globalCompositeOperation = 'source-in'
      shadowContext.fillStyle = shadow.color || '#000000'
      shadowContext.fillRect(0, 0, canvas.width, canvas.height)
      shadowContext.restore()
      shadowContext.save()
      shadowContext.globalCompositeOperation = 'destination-out'
      shadowContext.drawImage(engine.shadowMaskCanvas, 0, 0)
      shadowContext.restore()
      compositeContext.save()
      compositeContext.globalAlpha = shadow.opacity / 100 * engine.materialState.materials[materialId].opacity / 100
      compositeContext.drawImage(engine.shadowLayerCanvas, 0, 0)
      compositeContext.restore()
    })

    const lineContext = engine.lineCanvas.getContext('2d')
    const lineImage = lineContext.createImageData(canvas.width, canvas.height)
    const rgb = hexToRgb(lineColor)
    for (let i = 0; i < engine.lineAlpha.length; i += 1) {
      const offset = i * 4
      lineImage.data[offset] = rgb.r
      lineImage.data[offset + 1] = rgb.g
      lineImage.data[offset + 2] = rgb.b
      lineImage.data[offset + 3] = engine.lineAlpha[i] * (lineOpacity / 100)
    }
    lineContext.clearRect(0, 0, canvas.width, canvas.height)
    lineContext.putImageData(lineImage, 0, 0)
    drawArtworkLayers(ctx, engine, linePosition)
    renderRoutes()
  }

  const clearHover = () => {
    lastHoverSeedRef.current = -1
    if (hoverCanvasRef.current) {
      const canvas = hoverCanvasRef.current
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
    }
    if (hoverFrameRef.current) {
      window.clearTimeout(hoverFrameRef.current)
      hoverFrameRef.current = null
    }
    const engine = engineRef.current
    if (!engine.hoverCanvas || !engine.hoverBounds) return
    const { x, y, width, height } = engine.hoverBounds
    engine.hoverCanvas.getContext('2d').clearRect(x, y, width, height)
    engine.hoverBounds = null
    lastHoverSeedRef.current = -1
    // The separate hover canvas avoids recomputing fill layers and shadows on movement.
  }

  const paintHover = (pixels) => {
    const engine = engineRef.current
    if (!pixels.length || !engine.hoverCanvas) return clearHover()
    if (engine.hoverBounds) {
      const old = engine.hoverBounds
      engine.hoverCanvas.getContext('2d').clearRect(old.x, old.y, old.width, old.height)
    }
    let minX = engine.width
    let minY = engine.height
    let maxX = 0
    let maxY = 0
    pixels.forEach((pixel) => {
      const x = pixel % engine.width
      const y = (pixel / engine.width) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    })
    const width = maxX - minX + 1
    const height = maxY - minY + 1
    const preview = new ImageData(width, height)
    const rgb = hexToRgb(fillColor)
    pixels.forEach((pixel) => {
      const x = pixel % engine.width - minX
      const y = ((pixel / engine.width) | 0) - minY
      const offset = (y * width + x) * 4
      preview.data[offset] = rgb.r
      preview.data[offset + 1] = rgb.g
      preview.data[offset + 2] = rgb.b
      preview.data[offset + 3] = 72
    })
    engine.hoverCanvas.getContext('2d').putImageData(preview, minX, minY)
    engine.hoverBounds = { x: minX, y: minY, width, height }
    const overlay = hoverCanvasRef.current
    if (overlay) {
      overlay.width = engine.width
      overlay.height = engine.height
      overlay.getContext('2d').drawImage(engine.hoverCanvas, 0, 0)
    }
  }

  const rebuild = (notify = true, resetTimeline = false) => {
    const sourceCanvas = sourceRef.current
    if (!sourceCanvas) return
    endMaterialInteraction()
    onBusy(true)
    clearHover()
    window.requestAnimationFrame(() => {
      if (!canvasRef.current || sourceRef.current !== sourceCanvas) return
      const previous = engineRef.current
      const line = createLineMask(sourceCanvas, sensitivity, gapSize)
      const fill = new ImageData(line.width, line.height)
      if (!resetTimeline && previous.fill && previous.width === line.width && previous.height === line.height) fill.data.set(previous.fill.data)
      const displayFill = new ImageData(line.width, line.height)
      const fillCanvas = document.createElement('canvas')
      const lineCanvas = document.createElement('canvas')
      const hoverCanvas = document.createElement('canvas')
      fillCanvas.width = lineCanvas.width = hoverCanvas.width = line.width
      fillCanvas.height = lineCanvas.height = hoverCanvas.height = line.height
      engineRef.current = {
        ...line, fill, displayFill, history: [], fillCanvas, lineCanvas, hoverCanvas, hoverBounds: null,
        materialState: !resetTimeline && previous.materialState && previous.width === line.width && previous.height === line.height
          ? previous.materialState : createMaterialState(line.width * line.height),
        layerCounts: new Map(), layerOrder: [],
        routes: resetTimeline ? [] : previous.routes,
        routesVisible: resetTimeline || previous.routesVisible !== false,
      }
      selectRegion(null)
      canvasRef.current.width = line.width
      canvasRef.current.height = line.height
      onCanvasSize({ width: line.width, height: line.height })
      const regions = countClosedRegions(line.mask, line.width, line.height)
      engineRef.current.regions = regions
      onRegions(regions)
      refreshLayerCounts()
      render()
      onBusy(false)
      recordHistory(notify ? '重新识别区域' : '导入并识别线稿', resetTimeline)
      if (notify) onMessage(`区域识别完成 · ${regions} 个围合区域 · 已保留填色${line.bridgedPixels ? ` · 修复 ${line.bridgedPixels} 个缺口像素` : ''}`)
    })
  }

  useEffect(() => {
    if (!source) return
    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = source.width
    sourceCanvas.height = source.height
    sourceCanvas.getContext('2d').drawImage(source, 0, 0)
    sourceRef.current = sourceCanvas
    rebuild(false, true)
    // Source is the only dependency: rebuilding sensitivity is an explicit user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  useEffect(() => {
    if (tool !== 'crop' || !cropRequest || !engineRef.current.width) {
      if (tool !== 'crop') setCropSelection(null)
      return
    }
    const { width, height } = engineRef.current
    const inset = Math.max(12, Math.round(Math.min(width, height) * 0.06))
    const availableWidth = width - inset * 2
    const availableHeight = height - inset * 2
    let selectionWidth = availableWidth
    let selectionHeight = availableHeight
    if (cropRequest.ratio) {
      if (selectionWidth / selectionHeight > cropRequest.ratio) selectionWidth = selectionHeight * cropRequest.ratio
      else selectionHeight = selectionWidth / cropRequest.ratio
    }
    setCropSelection({
      x: Math.round((width - selectionWidth) / 2),
      y: Math.round((height - selectionHeight) / 2),
      width: Math.round(selectionWidth),
      height: Math.round(selectionHeight),
    })
  }, [cropRequest, tool])

  useEffect(render, [background, backgroundOpacity, fillLayerOpacities, fillLayerVisibility, fillLayerShadows, lineColor, lineOpacity, linePosition])

  useEffect(() => {
    lastHoverSeedRef.current = -1
    clearHover()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillColor, hoverPreview, tool])

  useEffect(() => () => {
    if (hoverFrameRef.current) window.clearTimeout(hoverFrameRef.current)
  }, [])

  useEffect(() => {
    // Finish even when a pointer is released outside its original slider.
    const finishPointer = () => { if (interactionRef.current?.mode === 'pointer') endMaterialInteraction() }
    window.addEventListener('pointerup', finishPointer)
    window.addEventListener('pointercancel', finishPointer)
    return () => {
      window.removeEventListener('pointerup', finishPointer)
      window.removeEventListener('pointercancel', finishPointer)
    }
  }, [])

  const restoreTimelineIndex = (index) => {
    const timeline = timelineRef.current
    const snapshot = timeline.entries[index]
    if (!snapshot) return false
    setRouteStart(null)
    clearHover()
    const fillCanvas = document.createElement('canvas')
    const lineCanvas = document.createElement('canvas')
    const hoverCanvas = document.createElement('canvas')
    fillCanvas.width = lineCanvas.width = hoverCanvas.width = snapshot.width
    fillCanvas.height = lineCanvas.height = hoverCanvas.height = snapshot.height
    sourceRef.current = snapshot.sourceCanvas
    engineRef.current = {
      mask: snapshot.mask,
      lineAlpha: snapshot.lineAlpha,
      fill: new ImageData(snapshot.width, snapshot.height),
      materialState: { ...snapshot.materialState, materials: structuredClone(snapshot.materialState.materials), assignments: decodeAssignments(snapshot.materialState.assignments, snapshot.width * snapshot.height) },
      displayFill: new ImageData(snapshot.width, snapshot.height),
      width: snapshot.width,
      height: snapshot.height,
      history: [],
      fillCanvas,
      lineCanvas,
      hoverCanvas,
      hoverBounds: null,
      layerCounts: new Map(snapshot.layerCounts),
      layerOrder: [...snapshot.layerOrder],
      regions: snapshot.regions,
      routes: snapshot.routes,
      routesVisible: snapshot.routesVisible,
    }
    canvasRef.current.width = snapshot.width
    canvasRef.current.height = snapshot.height
    timeline.index = index
    selectRegion(null)
    onRegions(snapshot.regions)
    onCanvasSize({ width: snapshot.width, height: snapshot.height })
    emitLayers()
    render()
    emitHistory()
    return true
  }

  useImperativeHandle(ref, () => ({
    editRoute(index, bend) {
      const engine = engineRef.current
      if (busy || !engine.routes?.[index] || engine.routes[index].bend === bend) return
      engine.routes = bend == null ? engine.routes.filter((_, i) => i !== index)
        : engine.routes.map((route, i) => i === index ? { ...route, bend } : route)
      render()
      recordHistory(bend == null ? '删除动线' : '调整动线')
    },
    toggleRoutes() {
      const engine = engineRef.current
      if (busy || !engine.routes?.length) return
      engine.routesVisible = engine.routesVisible === false
      render()
      recordHistory(engine.routesVisible ? '显示动线' : '隐藏动线')
    },
    recognize: rebuild,
    beginMaterialInteraction(mode = 'manual') { if (!interactionRef.current) interactionRef.current = { changed: false, mode } },
    endMaterialInteraction,
    clearSelection() { selectRegion(null); clearHover() },
    setColorShadows(color, shadow) {
      const engine = engineRef.current
      if (busy || !engine.materialState) return false
      if (!setColorShadows(engine.materialState, color, shadow)) return false
      refreshLayerCounts()
      if (selectionRef.current) selectRegion(selectionRef.current.seed)
      render()
      const label = color ? '调整同色阴影' : '全部添加阴影'
      if (interactionRef.current) Object.assign(interactionRef.current, { changed: true, label })
      else recordHistory(label)
      return true
    },
    updateMaterial(id, patch, { scope = 'material', seed = selectionRef.current?.seed } = {}) {
      const engine = engineRef.current
      if (busy || !engine.materialState?.materials[id]) return false
      if (JSON.stringify(normalizeMaterial({ ...engine.materialState.materials[id], ...patch })) === JSON.stringify(engine.materialState.materials[id])) return true
      let pixels
      if (scope === 'region') {
        if (seed == null) return false
        const result = findClosedRegion({ x: seed % engine.width, y: Math.floor(seed / engine.width), ...engine })
        if (result.status !== 'closed') return false
        pixels = result.pixels
      }
      const target = editMaterial(engine.materialState, id, patch, pixels)
      refreshLayerCounts()
      if (selectionRef.current) selectRegion(selectionRef.current.seed)
      render()
      const label = `调整材质 · ${materialName(engine.materialState.materials[target])}`
      if (interactionRef.current) Object.assign(interactionRef.current, { changed: true, label })
      else recordHistory(label)
      return true
    },
    removeTexture(id, options) {
      return ref.current.updateMaterial(id, { type: 'solid', name: '纯色' }, options)
    },
    deleteMaterial(id, { scope = 'material', seed = selectionRef.current?.seed } = {}) {
      endMaterialInteraction()
      const engine = engineRef.current
      if (busy || !engine.materialState?.materials[id]) return false
      let pixels
      if (scope === 'region') {
        if (seed == null) return false
        const region = findClosedRegion({ x: seed % engine.width, y: Math.floor(seed / engine.width), ...engine })
        if (region.status !== 'closed') return false
        pixels = region.pixels
      }
      deleteMaterial(engine.materialState, id, pixels)
      refreshLayerCounts(); selectRegion(null); render(); recordHistory('删除材质填充')
      return true
    },
    rotate(clockwise = true) {
      endMaterialInteraction()
      const engine = engineRef.current
      if (busy || !engine.fill || !sourceRef.current) return false
      clearHover()
      cropStartRef.current = null
      setCropSelection(null)
      const width = engine.height
      const height = engine.width
      const rotate = (data, channels = 1) => rotatePlane(data, engine.width, engine.height, channels, clockwise)
      const materialState = cloneMaterialState(engine.materialState)
      materialState.assignments = rotate(materialState.assignments)
      transformMaterials(materialState, clockwise ? [0, 1, -1, 0, engine.height, 0] : [0, -1, 1, 0, 0, engine.width])
      const sourceData = sourceRef.current.getContext('2d').getImageData(0, 0, engine.width, engine.height)
      const rotatedSource = document.createElement('canvas')
      rotatedSource.width = width
      rotatedSource.height = height
      rotatedSource.getContext('2d').putImageData(new ImageData(rotate(sourceData.data, 4), width, height), 0, 0)
      const fillCanvas = document.createElement('canvas')
      const lineCanvas = document.createElement('canvas')
      const hoverCanvas = document.createElement('canvas')
      for (const canvas of [fillCanvas, lineCanvas, hoverCanvas]) { canvas.width = width; canvas.height = height }
      sourceRef.current = rotatedSource
      engineRef.current = {
        ...engine, width, height, materialState, mask: rotate(engine.mask), lineAlpha: rotate(engine.lineAlpha),
        routes: transformRoutes(engine.routes, ([x, y]) => clockwise ? [engine.height - y, x] : [y, engine.width - x]),
        fill: new ImageData(rotate(engine.fill.data, 4), width, height), displayFill: new ImageData(width, height),
        fillCanvas, lineCanvas, hoverCanvas, hoverBounds: null, history: [],
      }
      canvasRef.current.width = width
      canvasRef.current.height = height
      onCanvasSize({ width, height })
      selectRegion(null)
      render()
      recordHistory(clockwise ? '向右旋转 90°' : '向左旋转 90°')
      return true
    },
    undo() {
      endMaterialInteraction()
      return restoreTimelineIndex(timelineRef.current.index - 1)
    },
    redo() {
      endMaterialInteraction()
      return restoreTimelineIndex(timelineRef.current.index + 1)
    },
    clearFills() {
      endMaterialInteraction()
      const engine = engineRef.current
      if (!engine.fill) return
      engine.fill.data.fill(0)
      engine.materialState = createMaterialState(engine.width * engine.height)
      selectRegion(null)
      engine.history = []
      engine.layerCounts = new Map()
      engine.layerOrder = []
      emitLayers()
      render()
      recordHistory('清空全部填色')
    },
    deleteLayer(color) {
      const id = Object.keys(engineRef.current.materialState.materials).find(id => engineRef.current.materialState.materials[id].color === color)
      return id ? ref.current.deleteMaterial(id) : false
    },
    exportPng({ scale = 1, transparent = false } = {}) {
      endMaterialInteraction()
      clearHover()
      render()
      const engine = engineRef.current
      const natural = document.createElement('canvas')
      natural.width = engine.width
      natural.height = engine.height
      const naturalContext = natural.getContext('2d')
      if (!transparent) {
        naturalContext.drawImage(canvasRef.current, 0, 0)
      } else {
        if (background) {
          const backgroundScale = Math.max(engine.width / background.width, engine.height / background.height)
          const width = background.width * backgroundScale
          const height = background.height * backgroundScale
          naturalContext.save()
          naturalContext.globalAlpha = backgroundOpacity / 100
          naturalContext.drawImage(background, (engine.width - width) / 2, (engine.height - height) / 2, width, height)
          naturalContext.restore()
        }
        drawArtworkLayers(naturalContext, engine, linePosition)
      }
      if (engine.routesVisible !== false) drawRoutes(naturalContext, engine.routes)
      const output = document.createElement('canvas')
      output.width = engine.width * scale
      output.height = engine.height * scale
      const outputContext = output.getContext('2d')
      outputContext.imageSmoothingEnabled = true
      outputContext.imageSmoothingQuality = 'high'
      outputContext.drawImage(natural, 0, 0, output.width, output.height)
      render()
      return output.toDataURL('image/png')
    },
    exportProjectData() {
      endMaterialInteraction()
      const engine = engineRef.current
      if (!engine.fill || !sourceRef.current) return null
      const rawFillCanvas = document.createElement('canvas')
      rawFillCanvas.width = engine.width
      rawFillCanvas.height = engine.height
      rawFillCanvas.getContext('2d').putImageData(new ImageData(materialBasePixels(engine.materialState), engine.width, engine.height), 0, 0)
      return {
        width: engine.width,
        height: engine.height,
        source: sourceRef.current.toDataURL('image/png'),
        fill: rawFillCanvas.toDataURL('image/png'),
        layerCounts: Array.from(engine.layerCounts.entries()),
        layerOrder: [...engine.layerOrder],
        routes: engine.routes || [],
        routesVisible: engine.routesVisible !== false,
        materialState: { materials: structuredClone(engine.materialState.materials), nextId: engine.materialState.nextId, assignments: encodeAssignments(engine.materialState.assignments) },
      }
    },
    async importProjectData(project, recognition = {}) {
      endMaterialInteraction()
      if (!project?.source || !project?.fill) return false
      if (!Number.isSafeInteger(project.width) || !Number.isSafeInteger(project.height) || project.width < 1 || project.height < 1 || project.width * project.height > 20_000_000) throw new Error('画布尺寸无效')
      clearHover()
      onBusy(true)
      const [sourceImage, fillImage] = await Promise.all([loadDataImage(project.source), loadDataImage(project.fill)])
      const sourceCanvas = document.createElement('canvas')
      sourceCanvas.width = project.width
      sourceCanvas.height = project.height
      sourceCanvas.getContext('2d').drawImage(sourceImage, 0, 0, project.width, project.height)
      const line = createLineMask(sourceCanvas, recognition.sensitivity ?? sensitivity, recognition.gapSize ?? gapSize)
      const fillCanvas = document.createElement('canvas')
      const lineCanvas = document.createElement('canvas')
      const hoverCanvas = document.createElement('canvas')
      fillCanvas.width = lineCanvas.width = hoverCanvas.width = project.width
      fillCanvas.height = lineCanvas.height = hoverCanvas.height = project.height
      const fillContext = fillCanvas.getContext('2d')
      fillContext.drawImage(fillImage, 0, 0, project.width, project.height)
      const fill = fillContext.getImageData(0, 0, project.width, project.height)
      let materialState
      let unknownMaterial = false
      if (project.materialState) {
        const assignments = decodeAssignments(project.materialState.assignments, project.width * project.height)
        const materials = {}
        for (const [id, value] of Object.entries(project.materialState.materials || {})) {
          if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0 || Number(id) > 4294967295) throw new Error('材质编号无效')
          materials[id] = normalizeMaterial(value)
          if (value.type !== materials[id].type) unknownMaterial = true
        }
        if (assignments.some(id => id !== 0 && !materials[id])) throw new Error('材质引用缺失')
        let maxId = 0
        for (const id of Object.keys(materials)) maxId = Math.max(maxId, Number(id))
        materialState = { assignments, materials, nextId: maxId + 1 }
      } else materialState = migrateLegacyFill(fill.data, recognition)
      const regions = countClosedRegions(line.mask, project.width, project.height)
      // Commit only after all images and material references validate. A bad
      // project must not replace the source of the work currently on screen.
      sourceRef.current = sourceCanvas
      engineRef.current = {
        ...line,
        routes: readRoutes(project.routes),
        routesVisible: project.routesVisible !== false,
        materialState,
        fill,
        displayFill: new ImageData(project.width, project.height),
        history: [],
        fillCanvas,
        lineCanvas,
        hoverCanvas,
        hoverBounds: null,
        // Counts are derived from geometry. Only retain valid order references;
        // malformed optional metadata must never make the new engine unusable.
        layerCounts: new Map(),
        layerOrder: Array.isArray(project.layerOrder) ? project.layerOrder.map(String).filter(id => materialState.materials[id]) : [],
        regions,
      }
      canvasRef.current.width = project.width
      canvasRef.current.height = project.height
      onCanvasSize({ width: project.width, height: project.height })
      onRegions(regions)
      refreshLayerCounts()
      selectRegion(null)
      render()
      onBusy(false)
      recordHistory('打开项目文件', true)
      if (unknownMaterial) onMessage('部分材质类型不支持，已保留底色作为纯色填充')
      return { unknownMaterial }
    },
    restoreHistory(id) {
      endMaterialInteraction()
      const timeline = timelineRef.current
      const index = timeline.entries.findIndex((entry) => entry.id === id)
      return restoreTimelineIndex(index)
    },
  }))

  const handleCanvasClick = (event) => {
    endMaterialInteraction()
    if (busy || !engineRef.current.fill) { onMessage('正在处理线稿，请稍后再填色'); return }
    if (tool === 'crop' || tool === 'route-move') return
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - rect.left) * canvas.width / rect.width)))
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - rect.top) * canvas.height / rect.height)))
    const engine = engineRef.current
    clearHover()
    if (tool === 'route') {
      if (!routeStart) {
        setRouteStart([x, y])
        onMessage('点击终点，箭头将指向终点')
      } else {
        const [startX, startY] = routeStart
        const dx = x - startX
        const dy = y - startY
        const end = [x, y]
        if (snapRoute) {
          if (Math.abs(dx) >= Math.abs(dy)) end[1] = startY
          else end[0] = startX
        }
        if (Math.hypot(end[0] - startX, end[1] - startY) < 2) return
        const width = Math.min(50, Math.max(2, engine.width / 250))
        engine.routes = [...(engine.routes || []), { start: routeStart, end, bend: 0, width }]
        engine.routesVisible = true
        setRouteStart(null)
        render()
        recordHistory('绘制动线')
      }
      return
    }
    if (tool === 'select') {
      const region = findClosedRegion({ x, y, ...engine })
      if (region.status === 'closed') { selectRegion(y * engine.width + x); paintHover(region.pixels); onMessage('已选中区域 · 在右侧调整材质') }
      else { selectRegion(null); onMessage(region.status === 'line' ? '点到线稿了，请点击区域内部' : '请选择围合区域') }
      return
    }
    const result = paintRegion(engine.materialState, { x, y, ...engine, material: activeMaterial || { color: fillColor } })
    if (result.status === 'filled') {
      refreshLayerCounts()
      selectRegion(y * engine.width + x)
      render()
      const material = engine.materialState.materials[result.id]
      recordHistory(`填充 · ${materialName(material)}`)
      onMessage(!material.visible || material.opacity === 0 ? '填充已保存，但材质图层不可见；请在图层中显示或调高透明度' : `已填充 ${materialName(material)} · 可撤销`)
    } else if (result.status === 'open') {
      onMessage('区域未封闭或连通画布边缘：点击「更多」中的「区域识别」，提高间隙修复强度后重新识别')
    } else if (result.status === 'line') {
      onMessage('点到线稿了，请点击线条围成的空白区域')
    } else if (result.status === 'same') {
      selectRegion(y * engine.width + x)
      onMessage('这里已是当前材质 · 可在右侧调整属性，或选择另一种材质替换')
    } else {
      onMessage('当前颜色或画布尚未准备好，请重新选色后再试')
    }
  }

  const pointFromEvent = (event) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(canvas.width, Math.round((event.clientX - rect.left) * canvas.width / rect.width))),
      y: Math.max(0, Math.min(canvas.height, Math.round((event.clientY - rect.top) * canvas.height / rect.height))),
    }
  }

  const handleCropPointerDown = (event) => {
    if (tool !== 'crop') return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    cropStartRef.current = point
    setCropSelection({ x: point.x, y: point.y, width: 1, height: 1 })
  }

  const handleCropPointerMove = (event) => {
    if (!busy && tool === 'bucket' && hoverPreview && !cropStartRef.current) {
      const rect = canvasRef.current.getBoundingClientRect()
      const engine = engineRef.current
      if (!engine.mask) return
      const x = Math.max(0, Math.min(engine.width - 1, Math.floor((event.clientX - rect.left) * engine.width / rect.width)))
      const y = Math.max(0, Math.min(engine.height - 1, Math.floor((event.clientY - rect.top) * engine.height / rect.height)))
      const seed = y * engine.width + x
      if (seed === lastHoverSeedRef.current) return
      lastHoverSeedRef.current = seed
      if (hoverFrameRef.current) window.clearTimeout(hoverFrameRef.current)
      hoverFrameRef.current = window.setTimeout(() => {
        hoverFrameRef.current = null
        const result = findClosedRegion({ x, y, mask: engine.mask, width: engine.width, height: engine.height })
        if (result.status === 'closed') paintHover(result.pixels)
        else clearHover()
      }, 85)
      return
    }
    const start = cropStartRef.current
    if (tool !== 'crop' || !start) return
    const point = pointFromEvent(event)
    let dx = point.x - start.x
    let dy = point.y - start.y
    const ratio = cropRequest?.ratio
    if (ratio && dx && dy) {
      const signX = Math.sign(dx)
      const signY = Math.sign(dy)
      if (Math.abs(dx) / Math.abs(dy) > ratio) dy = signY * Math.abs(dx) / ratio
      else dx = signX * Math.abs(dy) * ratio
      dx = Math.max(-start.x, Math.min(engineRef.current.width - start.x, dx))
      dy = Math.max(-start.y, Math.min(engineRef.current.height - start.y, dy))
      if (Math.abs(dx) / Math.max(1, Math.abs(dy)) > ratio) dx = Math.sign(dx) * Math.abs(dy) * ratio
      else dy = Math.sign(dy) * Math.abs(dx) / ratio
    }
    setCropSelection({
      x: Math.round(Math.min(start.x, start.x + dx)),
      y: Math.round(Math.min(start.y, start.y + dy)),
      width: Math.max(1, Math.round(Math.abs(dx))),
      height: Math.max(1, Math.round(Math.abs(dy))),
    })
  }

  const handleCropPointerUp = (event) => {
    if (!cropStartRef.current) return
    cropStartRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const moveRoute = (event, drag) => {
    const point = pointFromEvent(event)
    const dx = point.x - drag.start.x
    const dy = point.y - drag.start.y
    if (!dx && !dy) return drag.routes
    const [route] = transformRoutes([drag.routes[drag.index]], ([x, y]) => [x + dx, y + dy])
    return drag.routes.map((item, index) => index === drag.index ? route : item)
  }

  const handlePointerDown = event => {
    if (tool !== 'route-move') return handleCropPointerDown(event)
    const engine = engineRef.current
    if (busy || event.button !== 0 || routeDragRef.current || engine.routesVisible === false || !engine.routes?.length) return
    const start = pointFromEvent(event)
    const scale = engine.width / event.currentTarget.getBoundingClientRect().width
    const index = hitRoute(routeCanvasRef.current.getContext('2d'), engine.routes, start.x, start.y, 10 * scale)
    if (index < 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    routeDragRef.current = { pointerId: event.pointerId, routes: engine.routes, index, start }
    onRouteSelect(index)
    renderRoutes(engine.routes, index)
  }

  const handlePointerMove = event => {
    if (tool !== 'route-move') return handleCropPointerMove(event)
    const drag = routeDragRef.current
    if (drag?.pointerId === event.pointerId && drag.routes === engineRef.current.routes) {
      renderRoutes(moveRoute(event, drag), drag.index)
    }
  }

  const finishRouteDrag = (event, commit = false) => {
    const drag = routeDragRef.current
    if (drag?.pointerId !== event.pointerId) return
    routeDragRef.current = null
    const engine = engineRef.current
    if (commit && tool === 'route-move' && !busy && engine.routes === drag.routes) {
      const routes = moveRoute(event, drag)
      if (routes !== drag.routes) {
        engine.routes = routes
        recordHistory('移动动线')
      }
    }
    renderRoutes()
  }

  const applyCrop = () => {
    endMaterialInteraction()
    if (!cropSelection || cropSelection.width < 12 || cropSelection.height < 12) {
      onMessage('裁剪范围太小，请重新拖动选择')
      return
    }
    const engine = engineRef.current
    const x = Math.max(0, Math.min(engine.width - 1, Math.round(cropSelection.x)))
    const y = Math.max(0, Math.min(engine.height - 1, Math.round(cropSelection.y)))
    const width = Math.max(1, Math.min(engine.width - x, Math.round(cropSelection.width)))
    const height = Math.max(1, Math.min(engine.height - y, Math.round(cropSelection.height)))

    const cropPlane = (data, channels = 1) => {
      const ResultType = data.constructor
      const result = new ResultType(width * height * channels)
      for (let row = 0; row < height; row += 1) {
        const from = ((y + row) * engine.width + x) * channels
        result.set(data.subarray(from, from + width * channels), row * width * channels)
      }
      return result
    }

    const croppedSource = document.createElement('canvas')
    croppedSource.width = width
    croppedSource.height = height
    croppedSource.getContext('2d').drawImage(sourceRef.current, x, y, width, height, 0, 0, width, height)
    sourceRef.current = croppedSource

    const mask = cropPlane(engine.mask)
    const lineAlpha = cropPlane(engine.lineAlpha)
    const fillData = cropPlane(engine.fill.data, 4)
    const fill = new ImageData(new Uint8ClampedArray(fillData), width, height)
    const displayFill = new ImageData(width, height)
    const materialState = cloneMaterialState(engine.materialState)
    materialState.assignments = cropPlane(materialState.assignments)
    transformMaterials(materialState, [1, 0, 0, 1, -x, -y])
    const fillCanvas = document.createElement('canvas')
    const lineCanvas = document.createElement('canvas')
    const hoverCanvas = document.createElement('canvas')
    fillCanvas.width = lineCanvas.width = hoverCanvas.width = width
    fillCanvas.height = lineCanvas.height = hoverCanvas.height = height

    engineRef.current = {
      ...engine, materialState, mask, lineAlpha, fill, displayFill, width, height, fillCanvas, lineCanvas, hoverCanvas, hoverBounds: null, history: [],
      routes: transformRoutes(engine.routes, ([px, py]) => [px - x, py - y]),
    }
    canvasRef.current.width = width
    canvasRef.current.height = height
    const regions = countClosedRegions(mask, width, height)
    engineRef.current.regions = regions
    onRegions(regions)
    onCanvasSize({ width, height })
    selectRegion(null)
    clearHover()
    refreshLayerCounts()
    render()
    recordHistory(`裁剪为 ${width} × ${height} px`)
    setCropSelection(null)
    onCropApplied()
  }

  const cancelCrop = () => {
    cropStartRef.current = null
    setCropSelection(null)
    onCropCancel()
  }

  return (
    <div className={`paper-frame ${tool === 'crop' ? 'is-cropping' : ''}`} style={{ width: `${Math.round(700 * zoom / 100)}px` }}>
      <canvas
        ref={canvasRef}
        onClick={handleCanvasClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={event => { finishRouteDrag(event, true); handleCropPointerUp(event) }}
        onLostPointerCapture={finishRouteDrag}
        onPointerLeave={() => clearHover()}
        className={`art-canvas tool-${tool}`}
        aria-label="线稿填色画布"
      />
      <canvas ref={hoverCanvasRef} className="fill-hover-overlay" aria-hidden="true" />
      <canvas ref={routeCanvasRef} className="fill-hover-overlay" aria-hidden="true" />
      {tool === 'route' && routeStart && <i className="route-start" aria-hidden="true" style={{ left: `${routeStart[0] / engineRef.current.width * 100}%`, top: `${routeStart[1] / engineRef.current.height * 100}%` }} />}
      {tool === 'crop' && cropSelection ? (
        <div
          className="crop-selection"
          style={{
            left: `${cropSelection.x / engineRef.current.width * 100}%`,
            top: `${cropSelection.y / engineRef.current.height * 100}%`,
            width: `${cropSelection.width / engineRef.current.width * 100}%`,
            height: `${cropSelection.height / engineRef.current.height * 100}%`,
          }}
          aria-hidden="true"
        >
          <i className="crop-handle nw" /><i className="crop-handle ne" />
          <i className="crop-handle sw" /><i className="crop-handle se" />
        </div>
      ) : null}
      {tool === 'crop' ? (
        <div className="crop-actions">
          <span>{cropSelection ? `${cropSelection.width} × ${cropSelection.height} px` : '拖动选择裁剪范围'}</span>
          <button type="button" onClick={cancelCrop}>取消</button>
          <button className="apply" type="button" onClick={applyCrop}>应用裁剪</button>
        </div>
      ) : null}
    </div>
  )
})

export default EditorCanvas
