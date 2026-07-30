import fs from 'fs'
import path from 'path'

const dir = 'apps/api/src'
const testFiles = [
  'app.test.ts',
  'email.test.ts',
  'mcp.test.ts',
  'routes/academy.test.ts',
  'routes/agents.test.ts',
  'routes/github.test.ts',
  'routes/guidance.test.ts',
  'routes/keys.test.ts',
  'routes/me.test.ts',
  'routes/profile.test.ts',
  'routes/proof-of-work.test.ts',
  'routes/social.test.ts',
  'routes/submissions.test.ts',
  'routes/tasks.test.ts',
]

for (const file of testFiles) {
  const fullPath = path.join(dir, file)
  if (!fs.existsSync(fullPath)) continue
  let content = fs.readFileSync(fullPath, 'utf8')

  // Add the import if not present
  if (!content.includes('fakeWebsite')) {
    // If it imports fakeSocial, import fakeWebsite next to it or after it
    const importRegex = /import\s+\{\s*fakeSocial.*?\}\s*from\s*['"](.*?)social\.js['"]/
    const match = content.match(importRegex)
    if (match) {
      const socialImport = match[0]
      const websiteImportPath = match[1] + 'website.js'
      content = content.replace(
        socialImport,
        `${socialImport}\nimport { fakeWebsite } from '${websiteImportPath}'`,
      )
    } else {
      // Fallback just add it to top
      content =
        `import { fakeWebsite } from '${file.includes('routes') ? '../' : './'}__fixtures__/website.js'\n` +
        content
    }
  }

  // Add website to buildApp call
  content = content.replaceAll(
    /social:\s*fakeSocial\(\),/g,
    'social: fakeSocial(),\n    website: fakeWebsite(),',
  )
  content = content.replaceAll(
    /social:\s*\{\s*challenges\s*\},/g,
    'social: { challenges },\n    website: fakeWebsite(),',
  )

  fs.writeFileSync(fullPath, content)
}
