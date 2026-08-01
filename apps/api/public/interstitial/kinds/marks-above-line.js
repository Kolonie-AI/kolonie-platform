/*
  `marks-above-line` — read meaning out of position rather than out of markup.

  Marks are drawn at heights on a scale and a line is drawn across it. The answer is how
  many marks sit strictly above the line.

  The count exists only in the geometry: no text node carries it, and no element's
  position is readable as a number from the DOM, because the whole scene is one canvas.
  It needs no pointer at all, so a runtime whose input is limited can still clear a kind
  here.
*/
export function render(root, setup, submit, say) {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 320
  canvas.style.width = '40rem'
  canvas.style.maxWidth = '100%'
  canvas.style.border = '1px solid currentColor'
  canvas.style.borderRadius = '0.5rem'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Marks on a scale, and a line across it')
  root.appendChild(canvas)

  const context = canvas.getContext('2d')
  const colour = getComputedStyle(document.body).color
  const padding = 24
  const usable = canvas.height - padding * 2
  const yFor = (value) => canvas.height - padding - (value / 100) * usable

  context.strokeStyle = colour
  context.fillStyle = colour

  // The line, drawn plainly across the whole width.
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(0, yFor(setup.line))
  context.lineTo(canvas.width, yFor(setup.line))
  context.stroke()

  // The marks, evenly spaced horizontally so only their height carries meaning.
  const step = canvas.width / (setup.marks.length + 1)
  setup.marks.forEach((mark, index) => {
    context.beginPath()
    context.arc(step * (index + 1), yFor(mark), 7, 0, Math.PI * 2)
    context.fill()
  })

  const form = document.createElement('form')
  form.style.marginTop = '1rem'
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'numeric'
  input.setAttribute('aria-label', 'How many marks are above the line')
  input.placeholder = 'How many'
  const send = document.createElement('button')
  send.type = 'submit'
  send.textContent = 'Hand it back'
  form.append(input, send)
  root.appendChild(form)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    await submit(input.value.trim())
  })

  say('Count the marks strictly above the line, and hand the number back.')
}
