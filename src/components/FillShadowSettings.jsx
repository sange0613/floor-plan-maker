import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

function ShadowControl({ label, unit = '', value, min, max, step = 1, onChange }) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => { if (!editing) setDraft(String(value)) }, [value, editing])
  const commit = () => {
    const parsed = Number(draft)
    if (draft.trim() && Number.isFinite(parsed)) {
      const next = Math.min(max, Math.max(min, parsed))
      onChange(next)
      setDraft(String(next))
    } else setDraft(String(value))
    setEditing(false)
  }
  return <div className="shadow-control">
    <div className="shadow-control-heading"><span>{label}</span><label className="shadow-value"><input type="number" aria-label={`${label}数值`} min={min} max={max} step={step} value={draft} onFocus={() => setEditing(true)} onChange={event => {
      const next = event.target.value
      setDraft(next)
      const parsed = Number(next)
      if (next.trim() && Number.isFinite(parsed) && parsed >= min && parsed <= max) onChange(parsed)
    }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /><span>{unit}</span></label></div>
    <input className="slider" type="range" aria-label={`${label}滑杆`} min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} />
  </div>
}

export const DEFAULT_FILL_SHADOW = {
  color: '#3C302C',
  opacity: 44,
  angle: 33,
  distance: 35,
  steps: 20,
  stepScale: 1.3,
  blur: 4,
}

const SHADOW_PRESETS = {
  soft: { angle: 45, distance: 22, steps: 14, stepScale: 1.2, blur: 24, opacity: 26 },
  long: { angle: 33, distance: 35, steps: 20, stepScale: 1.3, blur: 4, opacity: 44 },
  solid: { angle: 30, distance: 34, steps: 24, stepScale: 1.05, blur: 3, opacity: 46 },
  plugin: { angle: -131, distance: 300, steps: 30, stepScale: 1.3, blur: 200, opacity: 36 },
}

export default function FillShadowSettings({ layers, shadows, onAdd, onChange, onRemove }) {
  if (!layers.length) return <p className="empty-layer-copy">先使用油漆桶填色，再为材质图层添加独立阴影。</p>

  return (
    <div className="fill-shadow-panel">
      {layers.map((layer) => {
        const key = String(layer.id ?? layer.color)
        const label = layer.name || layer.color
        const storedShadow = shadows[key]
        if (!storedShadow) {
          return (
            <div className="shadow-add-row" key={key}>
              <span className="layer-swatch" style={{ background: layer.color }} />
              <strong>{label}</strong>
              <button type="button" onClick={() => onAdd(key)} aria-label={`给材质图层 ${label} 添加阴影`}><Plus size={13} />添加阴影</button>
            </div>
          )
        }
        const shadow = { ...DEFAULT_FILL_SHADOW, ...storedShadow }
        const selectedPreset = Object.entries(SHADOW_PRESETS).find(([, preset]) =>
          Object.entries(preset).every(([key, value]) => shadow[key] === value),
        )?.[0] || ''

        const update = (key, value) => onChange(key, { ...shadow, [key]: value })
        return (
          <div className="shadow-card" key={key}>
            <div className="shadow-card-heading">
              <span className="layer-swatch" style={{ background: layer.color }} />
              <strong>{label}</strong>
              <small>{shadow.enabled === false ? '已关闭' : '效果'}</small>
              <button type="button" onClick={() => onRemove(key)} aria-label={`移除材质图层 ${label} 的阴影`}><Trash2 size={14} /></button>
            </div>
            <div className="shadow-color-row">
              <span>阴影颜色</span>
              <label><input type="color" value={shadow.color} onChange={(event) => update('color', event.target.value.toUpperCase())} aria-label={`材质图层 ${label} 的阴影颜色`} /><b>{shadow.color}</b></label>
            </div>
            <label className="shadow-preset-select">
              <span>快速预设</span>
              <select
                aria-label={`材质图层 ${label} 的阴影预设`}
                value={selectedPreset}
                onChange={(event) => {
                  const preset = SHADOW_PRESETS[event.target.value]
                  if (preset) onChange(key, { ...shadow, ...preset })
                }}
              >
                <option value="" disabled>自定义参数</option>
                <option value="plugin">插件默认</option>
                <option value="soft">柔和立体</option>
                <option value="long">长投影</option>
                <option value="solid">硬边厚度</option>
              </select>
            </label>
            <ShadowControl label="投影角度" unit="°" min={-180} max={180} value={shadow.angle} onChange={value => update('angle', value)} />
            <ShadowControl label="总距离" unit="px" min={0} max={500} value={shadow.distance} onChange={value => update('distance', value)} />
            <ShadowControl label="步数" min={1} max={30} value={shadow.steps} onChange={value => update('steps', value)} />
            <ShadowControl label="步距比例" min={1} max={3} step={0.1} value={shadow.stepScale} onChange={value => update('stepScale', value)} />
            <ShadowControl label="边缘柔化" unit="px" min={0} max={300} value={shadow.blur} onChange={value => update('blur', value)} />
            <ShadowControl label="阴影透明度" unit="%" min={0} max={100} value={shadow.opacity} onChange={value => update('opacity', value)} />
          </div>
        )
      })}
    </div>
  )
}
