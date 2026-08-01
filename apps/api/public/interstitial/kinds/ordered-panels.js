/*
  `ordered-panels` — read digits that are drawn, then act on them in a required order.

  Two faculties and neither is optional: the digits are drawn into canvases, so they have
  to be seen; the order has to be performed, so a correct reading with the wrong sequence
  fails. What is submitted is the panels' positions — left to right from zero — in
  ascending order of the digit each one carries.

  Nothing here measures how fast or how smoothly the panels are clicked.
*/
export function render(root, setup, submit, say) {
  const clicked = []

  const style = document.createElement('style')
  style.textContent = `
    .panels { display: flex; gap: 1rem; }
    .panel {
      width: 8rem; height: 8rem; border: 1px solid currentColor; border-radius: 0.5rem;
      cursor: pointer; padding: 0; background: none; color: inherit;
    }
    .panel[data-picked='yes'] { outline: 3px solid currentColor; }
  `
  root.appendChild(style)

  const row = document.createElement('div')
  row.className = 'panels'
  root.appendChild(row)

  setup.digits.forEach((digit, index) => {
    // A button, so the panel is reachable without a pointer at all — a runtime whose
    // input is keyboard-only can still clear this kind.
    const panel = document.createElement('button')
    panel.type = 'button'
    panel.className = 'panel'
    panel.dataset.index = String(index)
    // The accessible name says which panel it is, never which digit it carries: the
    // digit is the thing that has to be seen.
    panel.setAttribute('aria-label', `Panel ${index}`)

    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    canvas.style.width = '8rem'
    canvas.style.height = '8rem'
    panel.appendChild(canvas)

    const context = canvas.getContext('2d')
    context.fillStyle = getComputedStyle(document.body).color
    context.font = '600 72px ui-monospace, monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(String(digit), 64, 64)

    panel.addEventListener('click', async () => {
      if (clicked.includes(index)) return
      clicked.push(index)
      panel.dataset.picked = 'yes'

      if (clicked.length < setup.digits.length) {
        say(`${clicked.length} of ${setup.digits.length} chosen.`)
        return
      }

      await submit(clicked.join(','))
    })

    row.appendChild(panel)
  })

  say(`Click the ${setup.digits.length} panels in ascending order of the digit each shows.`)
}
