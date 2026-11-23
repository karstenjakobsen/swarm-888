import { expect, test, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { freePort, stop } from './processes'

const web = resolve(process.cwd())
const root = resolve(web, '..')
const python = join(root, '.venv/bin/python')
const artifactRoot = process.env.OPERATOR_CATALOG_ACCEPTANCE_DIR

async function withCatalog(
  page: Page, scenario: 'typed' | 'migration',
  check: (origin: string, directory: string, fixture: Record<string, any>) => Promise<void>,
) {
  const base = artifactRoot || tmpdir()
  await mkdir(base, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(base, `catalog-${scenario}-`))
  const children: ChildProcess[] = []
  try {
    const fixture = JSON.parse(execFileSync(python, ['tests/catalog_walkthrough.py', scenario, directory], {
      cwd: root, env: { ...process.env, PYTHONPATH: root }, encoding: 'utf8',
    }))
    const port = await freePort()
    const origin = 'http://127.0.0.1:' + port
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPERATOR_MODE: 'live', OPERATOR_STATE_DIR: fixture.state, OPERATOR_ORIGIN: origin,
      OPERATOR_PORT: port, WEB_PORT: await freePort(), CONTROLLER_PORT: await freePort(),
      XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, NEXT_TELEMETRY_DISABLED: '1',
    }
    if (scenario === 'typed') {
      Object.assign(env, {
        OPERATOR_MODEL: 'simulated', OPERATOR_SIMULATED_SKILL: fixture.fixture,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${fixture.remote}.insteadOf`,
        GIT_CONFIG_VALUE_0: fixture.repo,
      })
    }
    function run(command: string, args: string[], cwd = root) {
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'inherit'] })
      children.push(child)
    }
    run(python, ['-m', 'operator_v1.serve'])
    if (scenario === 'typed') run(python, ['-m', 'operator_v1.worker'])
    run(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', env.WEB_PORT!], web)
    run(process.env.CADDY || 'caddy', ['run', '--config', 'Caddyfile', '--adapter', 'caddyfile'])
    await expect.poll(async () => {
      try { return (await page.request.get(origin + '/api/snapshot')).status() } catch { return 0 }
    }).toBe(401)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin)
    await page.getByLabel('Owner key').fill((await readFile(join(fixture.state, 'owner.key'), 'utf8')).trim())
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Morning brief' })).toBeVisible()
    await check(origin, directory, fixture)
  } finally {
    await page.close()
    for (const child of children.reverse()) await stop(child)
    if (!artifactRoot) await rm(directory, { recursive: true, force: true })
  }
}

function git(directory: string, ...args: string[]) {
  return execFileSync('git', ['-C', directory, '-c', 'user.name=Operator fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }).trim()
}

test('shared catalog setup, authoring, reviewed publish and pinned reuse', async ({ page }) => {
  test.setTimeout(60_000)
  await withCatalog(page, 'typed', async (origin, directory, fixture) => {
    const headers = { Origin: origin, 'X-Operator-Action': '1' }
    await page.getByRole('link', { name: 'Connect a catalog' }).click()
    const catalog = page.getByRole('region', { name: 'Catalog repository' })
    await expect(catalog.getByText('create-skill', { exact: true })).toBeVisible()
    await expect(catalog.getByText('connect-catalog', { exact: true })).toBeVisible()
    await catalog.getByLabel('GitHub SSH URL').fill(fixture.repo)
    await catalog.getByRole('button', { name: 'Connect catalog' }).click()
    for (const name of ['Check disk', 'DigitalOcean fixture', 'KJ API']) {
      await expect(catalog.getByRole('listitem').filter({ hasText: name })).toBeVisible()
    }
    const attached = await page.request.post(origin + '/api/catalog', {
      headers, data: { remote: fixture.repo, kinds: ['skill', 'connector', 'project'] },
    })
    expect(attached.status()).toBe(200)
    const bindings = (await attached.json()).connections
    expect(new Set(bindings.map((connection: { revision: string }) => connection.revision))).toEqual(new Set([fixture.revision]))
    expect(git(fixture.remote, 'rev-parse', 'main')).toBe(fixture.revision)

    async function send(text: string) {
      await page.goto(origin)
      await page.getByRole('textbox').fill(text)
      await page.getByRole('button', { name: 'Send' }).click()
      await page.getByRole('link').filter({ hasText: text }).click()
      await expect(page.getByRole('heading', { name: text })).toBeVisible()
      const task = new URL(page.url()).pathname.split('/').at(-1)
      let invocation: any
      await expect.poll(async () => {
        const snapshot = await (await page.request.get(origin + '/api/snapshot')).json()
        invocation = snapshot.events.find((event: any) => event.task === task && event.data.action === 'skill_invoked')
        return invocation?.data.result
      }).toMatch(/^old:/)
      return { task, path: new URL(page.url()).pathname, invocation: invocation.data }
    }

    const creating = await send('Look up fixture `swarm.test=a`')
    const pinned = creating.invocation.revision
    const connector = await page.request.post(origin + '/api/catalog/items', {
      headers, data: { kind: 'connector', item: 'karstenjakobsen-connector-digital-ocean', definition: {
        name: 'Updated DigitalOcean fixture', endpoint: 'http://127.0.0.1:8765/mcp',
        auth: 'bearer', tool: 'read_fixture', secret_ref: 'digital-ocean',
      } },
    })
    expect(connector.status()).toBe(200)
    await page.goto(origin + '/inspect?tab=catalog')
    await page.getByRole('button', { name: 'Preview publish' }).click()
    const preview = page.getByRole('region', { name: 'Publish preview' })
    const branch = bindings[0].branch_id
    const reviewed = await (await page.request.get(origin + `/api/catalog/branches/${branch}/publish`)).json()
    expect(reviewed.commits).toHaveLength(2)
    await expect(preview).toContainText('fixture-lookup/run.lua')
    await expect(preview).toContainText('digital-ocean/operator.yaml')
    await expect(preview).toContainText('skill · karstenjakobsen-skill-fixture-lookup')
    await expect(preview).toContainText('connector · karstenjakobsen-connector-digital-ocean')
    await preview.getByRole('button', { name: 'Publish reviewed commits' }).click()
    await expect(page.getByText(/Publish verified/)).toBeVisible()
    expect(git(fixture.remote, 'rev-parse', 'main')).toBe(reviewed.local_revision)

    const collaborator = join(directory, 'collaborator')
    git(directory, 'clone', fixture.remote, collaborator)
    await writeFile(join(collaborator, 'fixture-lookup/run.lua'), 'return function(args) return "new:" .. args.selector end\n')
    git(collaborator, 'commit', '-am', 'Change only the skill implementation')
    git(collaborator, 'push', 'origin', 'main')
    const updated = git(collaborator, 'rev-parse', 'HEAD')
    await page.getByRole('button', { name: 'Pull branch' }).click()
    await expect(page.getByText(`Active · ${pinned}`, { exact: true })).toBeVisible()
    await expect(page.getByText(updated, { exact: false }).first()).toBeVisible()
    const reuse = await send('Look up fixture `swarm.test=b`')
    expect(reuse.invocation.revision).toBe(pinned)
    expect(reuse.invocation.result).toBe('old:swarm.test=b')
    expect(creating.invocation.result).toBe('old:swarm.test=a')
    await writeFile(join(directory, 'evidence.json'), JSON.stringify({
      model: 'simulated', creating, reuse, pinned, updated, reviewed, remote_tip: updated,
    }, null, 2) + '\n')
  })
})

test('a copied pre-migration task still opens with its original revision', async ({ page }) => {
  test.setTimeout(60_000)
  await withCatalog(page, 'migration', async (origin, directory, fixture) => {
    const path = '/work/' + fixture.task
    await page.goto(origin + path)
    await expect(page.getByRole('heading', { name: fixture.title })).toBeVisible()
    const revision = page.locator(`a[href="/skills/${fixture.skill}?rev=${fixture.pinned}"]`).first()
    await expect(revision).toBeVisible()
    expect(await revision.getAttribute('href')).toContain(fixture.pinned)
    await revision.click()
    await expect(page).toHaveURL(new RegExp(fixture.pinned))
    await expect(page.getByRole('region', { name: 'Procedure' })).toContainText(fixture.pinned)
    await writeFile(join(directory, 'evidence.json'), JSON.stringify({ ...fixture, path }, null, 2) + '\n')
  })
})
