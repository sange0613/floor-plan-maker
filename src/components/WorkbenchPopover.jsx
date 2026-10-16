import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'

// Modeless command/settings panel. Only open panels attach dismissal listeners.
export default function WorkbenchPopover({ label, trigger, open, onToggle, onClose, triggerClass = '', panelClass = '', children }) {
  const id = useId()
  const root = useRef(null)
  const button = useRef(null)
  const panel = useRef(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return undefined
    panel.current?.focus()
    const outside = event => { if (!root.current?.contains(event.target)) close.current() }
    const escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close.current()
      button.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return <div className={`workbench-popover ${open ? 'is-open' : ''}`} ref={root}>
    <button ref={button} type="button" className={triggerClass} aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="dialog" onClick={onToggle}>{trigger}</button>
    {open ? <section id={id} ref={panel} tabIndex={-1} role="dialog" aria-label={label} className={`workbench-popover-panel ${panelClass}`}>
      <div className="workbench-popover-heading"><strong>{label}</strong><button type="button" aria-label={`关闭${label}`} onClick={() => { onClose(); button.current?.focus() }}><X size={15} /></button></div>
      {children}
    </section> : null}
  </div>
}
