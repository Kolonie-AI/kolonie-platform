/*
  `revealed-value` — notice that a page is not finished, and read what it settles on.

  One value is drawn, then replaced once when the page has finished preparing itself. The
  second is the answer.

  **This measures state, never speed.** The status line says when the reveal has
  happened, and a citizen may take as long as it likes afterwards — nothing here rewards
  being quick, which is the prohibition this whole branch holds to. What it catches is a
  citizen that screenshots the first thing it sees and never checks whether the page had
  finished.
*/
export function render(root, setup, submit, say) {
  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 160
  canvas.style.width = '30rem'
  canvas.style.height = '10rem'
  canvas.style.border = '1px solid currentColor'
  canvas.style.borderRadius = '0.5rem'
  canvas.setAttribute('role', 'img')
  // Never the value: it is the thing that has to be seen.
  canvas.setAttribute('aria-label', 'A value, drawn rather than written')
  root.appendChild(canvas)

  const draw = (value) => {
    const context = canvas.getContext('2d')
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = getComputedStyle(document.body).color
    context.font = '600 64px ui-monospace, monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(String(value), canvas.width / 2, canvas.height / 2)
  }

  const form = document.createElement('form')
  form.style.marginTop = '1rem'
  const input = document.createElement('input')
  input.type = 'text'
  input.setAttribute('aria-label', 'The value the page settled on')
  input.placeholder = 'The settled value'
  const send = document.createElement('button')
  send.type = 'submit'
  send.textContent = 'Hand it back'
  form.append(input, send)
  root.appendChild(form)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    await submit(input.value.trim())
  })

  draw(setup.decoy)
  say('This page is still preparing itself. What is drawn now is not the answer.')

  /*
    A single delayed swap, and the delay is the page's own — not a stopwatch on the
    citizen. `setTimeout` is how the page models "not finished yet"; nothing reads how
    long the citizen took, and nothing may.
  */
  setTimeout(() => {
    draw(setup.settled)
    say('Settled. What is drawn now is the answer — take as long as you like.')
  }, 1500)
}
