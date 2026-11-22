import { expect, test, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { freePort, stop } from './processes'

const web = resolve(process.cwd())
const root = resolve(web, '..')
const python = join(root, '.venv/bin/python')
const image = process.env.OPERATOR_FIXTURE_IMAGE ?? 'alpine:3.22'
const model = process.env.OPERATOR_ACCEPTANCE_MODEL ?? 'simulated'
const prompt = 'Tell me the state of the containers in this demo project. Include each container’s name, image, state, and exit code if it has exited. If you need a reusable skill for this, create one.'

function docker(...args: string[]) {
  return execFileSync('docker', args, {encoding: 'utf8', timeout: 20_000}).trim()
}

function observe(selector: string) {
  const stdout = docker('container', 'ls', '-a', '--filter', 'label=' + selector,
    '--format', '{{json .}}')
  const rows = stdout ? stdout.split('\n').map(line => {
    const container = JSON.parse(line)
    const result = {name: container.Names, image: container.Image, state: container.State}
    if (container.State === 'exited') {
      return {...result, exitCode: Number(docker('container', 'inspect',
        '--format', '{{.State.ExitCode}}', container.ID))}
    }
    return result
  }) : []
  return {selector, rows}
}

test('learns a read-only Docker skill and reuses its Git revision after worker restart', async ({page, context, request}) => {
  test.skip(process.env.OPERATOR_ACCEPTANCE_DOCKER !== '1', 'Run make acceptance-docker explicitly')
  test.setTimeout(650_000)
  page.setDefaultTimeout(12_000)
  expect(['simulated', 'codex']).toContain(model)
  console.log('Docker context', docker('context', 'show'), 'engine', docker('info', '--format', '{{.Name}} {{.ServerVersion}}'))
  docker('image', 'inspect', image, '--format', '{{.Id}}')
  const directory = await mkdtemp(join(process.env.OPERATOR_ACCEPTANCE_PARENT ?? tmpdir(), 'operator-docker-'))
  const state = join(directory, 'state')
  const owner = 'swarm.operator.acceptance=' + (process.env.OPERATOR_ACCEPTANCE_FIXTURE_RUN ?? crypto.randomUUID())
  console.log('Walkthrough state', directory)
  const owned: string[] = []
  const fixture = (selector: string, name: string, command: string) => {
    const id = docker('container', 'create', '--pull=never', '--label', owner, '--label', selector,
      '--name', name, image, 'sh', '-c', command)
    owned.push(id)
    docker('container', 'start', id)
    return id
  }
  const webPort = await freePort()
  const controllerPort = await freePort()
  const port = await freePort()
  const origin = 'http://127.0.0.1:' + port
  const env = { ...process.env, OPERATOR_MODE: 'live', OPERATOR_MODEL: model,
    OPERATOR_STATE_DIR: state, OPERATOR_ORIGIN: origin, OPERATOR_PORT: port,
    CONTROLLER_PORT: controllerPort, WEB_PORT: webPort, NEXT_TELEMETRY_DISABLED: '1',
    OPERATOR_CATALOG_REMOTE: join(directory, 'remote.git'),
    OPERATOR_CATALOG_BRANCH: 'main', OPERATOR_CATALOG_CHECKOUT: join(directory, 'catalog'),
    OPERATOR_SIMULATED_SKILL: join(directory, 'simulated-skill.json'),
    XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory }
  const children: ChildProcess[] = []
  function run(command: string, args: string[], cwd = root, extraEnv?: Record<string, string>) {
    const child = spawn(command, args, { cwd, env: {...env, ...extraEnv}, stdio: ['ignore', 'ignore', 'inherit'] })
    children.push(child)
    return child
  }
  function execute(command: string, args: string[], input?: string) {
    return execFileSync(command, args, {cwd: root, env, encoding: 'utf8', input, timeout: 45_000}).trim()
  }
  async function signIn(tab: Page) {
    await tab.setViewportSize({width: 390, height: 844})
    await tab.goto(origin)
    await tab.getByLabel('Owner key').fill((await readFile(join(state, 'owner.key'), 'utf8')).trim())
    await tab.getByRole('button', {name: 'Sign in'}).click()
    await expect(tab.getByRole('heading', {name: 'Morning brief'})).toBeVisible()
  }
  async function ask(tab: Page, text: string, waits = false) {
    await tab.getByRole('textbox').fill(text)
    const receipt = tab.waitForResponse(response => response.url() === origin + '/api/commands')
    await tab.getByRole('button', {name: 'Send'}).click()
    const response = await receipt
    expect(response.status()).toBe(202)
    const {taskId} = await response.json()
    await tab.locator('a[href="/work/' + taskId + '"]').first().click()
    await expect(tab.getByRole('heading', {name: text, exact: true})).toBeVisible()
    if (!waits) await expect.poll(async () => {
      const snapshot = await (await tab.request.get(origin + '/api/snapshot')).json()
      return snapshot.tasks.find((task: {id: string}) => task.id === taskId)?.checkpoint
    }, {timeout: 275_000}).toBe('completed')
    const snapshot = await (await tab.request.get(origin + '/api/snapshot')).json()
    return {taskId, events: snapshot.events.filter((event: {task: string}) => event.task === taskId)}
  }
  try {
    execute('git', ['init', '--bare', env.OPERATOR_CATALOG_REMOTE])
    execute('make', ['catalog-init', 'owner-key'])
    if (model === 'simulated') {
      await writeFile(env.OPERATOR_SIMULATED_SKILL, execute(python, ['tests/fixture_inspection.py', 'request']), {mode: 0o600})
    }
    if (process.env.OPERATOR_ACCEPTANCE_MEMORY === '1') {
      const catalog = env.OPERATOR_CATALOG_CHECKOUT
      await writeFile(join(catalog, 'projects/example.json'), JSON.stringify({
        name: 'Example project', description: 'An independent application repository.',
        repo: 'https://example.invalid/application.git',
      }))
      execute('git', ['-C', catalog, 'add', '--', 'projects'])
      execute('git', ['-C', catalog, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
        'commit', '-m', 'Configure the fixture project'])
    }
    const token = process.env.OPERATOR_ACCEPTANCE_CONNECTOR === '1' ? 'fixture-' + crypto.randomUUID() : undefined
    if (token) {
      const connectorPort = await freePort()
      const binding = {endpoint: 'http://127.0.0.1:' + connectorPort + '/mcp', secret_ref: 'fixture-token'}
      const definition = {...binding, name: 'Fixture', auth: 'bearer', tool: 'fixture_status', timeout: 1}
      const catalog = env.OPERATOR_CATALOG_CHECKOUT
      await writeFile(join(state, 'connector-bindings.json'), JSON.stringify({fixture: binding}), {mode: 0o600})
      await writeFile(join(catalog, 'connectors/fixture.json'), JSON.stringify(definition))
      execute('git', ['-C', catalog, 'add', '--', 'connectors'])
      execute('git', ['-C', catalog, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
        'commit', '-m', 'Configure the fixture connector'])
      run(python, ['-m', 'uvicorn', 'fixture_connector:app', '--app-dir', 'tests', '--port', connectorPort], root,
        {FIXTURE_MCP_TOKEN: token})
    }
    const discovery = JSON.parse(execute(python, ['-m', 'operator_v1.skill_list', 'docker']))
    expect(discovery.installed.skills.map((skill: {skill: string}) => skill.skill)).toEqual(['create-skill'])
    expect(discovery.matches.skills).toEqual([])
    run(python, ['-m', 'operator_v1.serve'])
    run(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', webPort], web)
    run(process.env.CADDY || 'caddy', ['run', '--config', 'Caddyfile', '--adapter', 'caddyfile'])
    let worker = run(python, ['-m', 'operator_v1.worker'])
    await expect.poll(async () => {
      try { return (await request.get(origin + '/api/snapshot')).status() } catch { return 0 }
    }).toBe(401)
    await signIn(page)
    const suffix = crypto.randomUUID().slice(0, 12)
    const selector = 'swarm.operator.project=' + suffix + '-first'
    const empty = 'swarm.operator.project=' + suffix + '-empty'
    const dockerPath = execute('which', ['docker'])
    const updatePolicy = () => execute(python, ['tests/fixture_inspection.py', 'policy', state, dockerPath,
      'swarm\\.operator\\.project=' + suffix + '-(first|empty|reuse)', ...owned])
    const firstExit = fixture(selector, 'swarm-' + suffix + '-exit7', 'exit 7')
    fixture(selector, 'swarm-' + suffix + '-running', 'sleep 900')
    expect(docker('container', 'wait', firstExit)).toBe('7')
    updatePolicy()
    const first = await ask(page, prompt + ' Sort containers by name. Use label `' + selector + '`. Also run the skill with `' + empty + '` and report the empty selection.')
    expect(first.events.at(-1)?.kind, JSON.stringify(first.events)).toBe('completed')
    const actions = first.events.map((event: {data: {action?: string}}) => event.data.action)
    for (const action of ['authoring_guide', 'skill_built', 'skill_tested', 'skill_activated', 'skill_invoked']) {
      expect(actions, JSON.stringify(first.events)).toContain(action)
    }
    expect(first.events.some((event: {data: {action?: string, matches?: string[]}}) =>
      event.data.action === 'skill_discovery' && event.data.matches?.length === 0)).toBe(true)
    const observations = [observe(selector), observe(empty)]
    expect(observations[0].rows).toHaveLength(2)
    expect(observations[1].rows).toEqual([])
    const grade = (taskId: string, rows: ReturnType<typeof observe>[]) =>
      JSON.parse(execute(python, ['-m', 'operator_v1.docker_grade', taskId], JSON.stringify({observations: rows})))
    const created = grade(first.taskId, observations)
    await expect(page.getByText('Verified independently', {exact: true}).first()).toBeVisible()
    const head = () => execute('git', ['-C', env.OPERATOR_CATALOG_CHECKOUT, 'rev-parse', 'HEAD'])
    const initialHead = head()
    await stop(worker)
    worker = run(python, ['-m', 'operator_v1.worker'])
    const reusedSelector = 'swarm.operator.project=' + suffix + '-reuse'
    const secondExit = fixture(reusedSelector, 'swarm-' + suffix + '-exit13', 'exit 13')
    fixture(reusedSelector, 'swarm-' + suffix + '-live', 'sleep 900')
    expect(docker('container', 'wait', secondExit)).toBe('13')
    updatePolicy()
    const fresh = await context.newPage()
    fresh.setDefaultTimeout(12_000)
    await fresh.setViewportSize({width: 390, height: 844})
    await fresh.goto(origin)
    const later = await ask(fresh, prompt + ' Sort containers by name. Use label `' + reusedSelector + '`.')
    expect(later.events.at(-1)?.kind, JSON.stringify(later.events)).toBe('completed')
    expect(later.events.some((event: {data: {action?: string}}) =>
      event.data.action === 'skill_built' || event.data.action === 'skill_revised')).toBe(false)
    const laterObservations = [observe(reusedSelector)]
    const reused = grade(later.taskId, laterObservations)
    expect(reused.revision).toBe(created.revision)
    expect(head()).toBe(initialHead)
    expect(created.revision).toMatch(/^[a-f0-9]{40}$/)
    await expect(fresh.getByText('Verified independently', {exact: true}).first()).toBeVisible()
    const revisionPath = '/skills/' + created.skill + '?rev=' + created.revision
    await fresh.locator('a[href="' + revisionPath + '"]').first().click()
    await expect(fresh.getByRole('heading', {name: 'Verified on a later task'})).toBeVisible()
    await fresh.locator('a[href="/work/' + later.taskId + '"]').first().click()
    await expect(fresh.getByText('Verified independently', {exact: true}).first()).toBeVisible()
    const skillPath = 'skills/' + created.skill
    const tree = execute('git', ['-C', env.OPERATOR_CATALOG_CHECKOUT, 'ls-tree', '-r', created.revision, '--', skillPath])
    expect(tree.split('\n').map(line => line.split('\t')[1])).toEqual(
      ['run.lua', 'skill.json', 'tests.json'].map(file => skillPath + '/' + file))
    const gitFile = (filename: string) => execute('git', ['-C', env.OPERATOR_CATALOG_CHECKOUT,
      'show', created.revision + ':' + skillPath + '/' + filename])
    for (const filename of ['run.lua', 'skill.json', 'tests.json']) {
      await writeFile(join(directory, filename), gitFile(filename) + '\n', {mode: 0o600})
    }
    const manifest = JSON.parse(gitFile('skill.json'))
    expect(manifest.program).toMatchObject({source: 'executable', entrypoint: 'run.lua', dependencies: ['docker']})
    const calls = (events: Array<{data: { action?: string, revision?: string }}>) =>
      events.filter(event => event.data.action === 'skill_invoked').map(event => event.data)
    const creatingCalls = calls(first.events)
    const reuseCalls = calls(later.events)
    expect(creatingCalls.map(call => call.revision)).toEqual([created.revision, created.revision])
    expect(reuseCalls.map(call => call.revision)).toEqual([created.revision])
    const evidence = {mode: model, creatingTask: '/work/' + first.taskId, reuseTask: '/work/' + later.taskId,
      skillRevision: revisionPath, revision: created.revision, tree, creatingCalls, reuseCalls, observations, laterObservations}
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600})
    console.log(JSON.stringify(evidence, null, 2))
    if (process.env.OPERATOR_ACCEPTANCE_MEMORY === '1') {
      await fresh.goto(origin)
      const written = await ask(fresh, 'Remember fixture port: The demo project listens on port 8080.')
      const entry = written.events.find((event: {data: {action?: string}}) =>
        event.data.action === 'memory_written')?.data.memory
      expect(entry).toMatch(/^[a-f0-9]{32}$/)
      const path = '/inspect/memory/' + entry
      await fresh.locator('a[href^="' + path + '"]').first().click()
      await expect(fresh.getByRole('heading', {name: 'Fixture port'})).toBeVisible()
      await fresh.getByRole('button', {name: 'Ask the operator to correct this'}).click()
      await fresh.getByLabel('What is wrong or out of date?').fill('The demo project listens on port 8443.')
      const submitted = fresh.waitForResponse(response => response.url() === origin + '/api/commands')
      await fresh.getByRole('button', {name: 'Send to operator'}).click()
      const {taskId: correction} = await (await submitted).json()
      await expect(fresh.getByText('The demo project listens on port 8443.', {exact: true})).toBeVisible({timeout: 25_000})
      await expect(fresh.getByText('The demo project listens on port 8080.', {exact: true})).toBeVisible()
      await expect(fresh.locator('a[href="/work/' + correction + '"]').first()).toBeVisible()
      await fresh.goto(origin)
      const reader = await ask(fresh, 'What is the fixture port you remember?')
      await fresh.locator('a[href^="' + path + '"]').first().click()
      await expect(fresh.locator('a[href="/work/' + reader.taskId + '"]').first()).toBeVisible()
      console.log('Memory correction and provenance', {path, correction, reader: reader.taskId})
      await fresh.goto(origin)
      const project = await ask(fresh, 'Read project example')
      await fresh.getByRole('link', {name: 'Inspect', exact: true}).click()
      await expect(fresh.getByRole('heading', {name: 'Catalog repository'})).toBeVisible()
      await fresh.getByRole('link', {name: /^Projects/}).click()
      await fresh.locator('a[href="/inspect/projects/example"]').first().click()
      await expect(fresh.getByRole('heading', {name: 'Example project'})).toBeVisible()
      await expect(fresh.getByRole('link', {name: 'https://example.invalid/application.git'}))
        .toHaveAttribute('href', 'https://example.invalid/application.git')
      await fresh.locator('a[href="/work/' + project.taskId + '"]').first().click()
      await expect(fresh.getByRole('heading', {name: 'Read project example', exact: true})).toBeVisible()
    }
    if (token) {
      await fresh.goto(origin)
      const credentialTask = await ask(fresh, 'Read connector fixture', true)
      await fresh.getByRole('button', {name: 'Review credential request'}).first().click()
      const dialog = fresh.getByRole('dialog')
      await dialog.getByLabel('Bearer token').fill(token)
      const supplied = fresh.waitForResponse(response => response.url() === origin + '/api/secrets')
      await dialog.getByRole('button', {name: 'Save credential and resume'}).click()
      expect((await supplied).status()).toBe(204)
      await fresh.locator('a[href="/inspect/connectors/fixture"]').first().click()
      await expect(fresh.getByRole('heading', {name: 'Fixture'})).toBeVisible()
      await expect(fresh.getByText('fixture_status', {exact: true}).first()).toBeVisible()
      await fresh.locator('a[href^="/work/' + credentialTask.taskId + '#"]').first().click()
      await expect(fresh.getByRole('heading', {name: 'Read connector fixture'})).toBeVisible()
      await fresh.goto(origin)
      const delayed = await ask(fresh, 'Read connector fixture slowly')
      await expect(fresh.getByText(/Connector .* timed out/).first()).toBeVisible()
      expect(delayed.events.some((event: {data: {action?: string}}) => event.data.action === 'connector_used')).toBe(false)
      expect((await (await fresh.request.get(origin + '/api/snapshot')).text()).includes(token)).toBe(false)
      console.log('Connector resumed original task and reported timeout', {task: credentialTask.taskId, timeout: delayed.taskId})
    }
    if (process.env.OPERATOR_ACCEPTANCE_DEFENSE === '1') {
      const defense = join(state, 'defense')
      const path = join(defense, 'proof.txt')
      await mkdir(defense, {mode: 0o700})
      await writeFile(path, 'fixture\n', {mode: 0o600})
      await fresh.goto(origin)
      const result = await ask(fresh, 'Maintain fixture proof.txt at mode 700')
      expect(result.events.some((event: {data: {action?: string}}) => event.data.action === 'goal_created')).toBe(true)
      await expect.poll(async () => (await stat(path)).mode & 0o777).toBe(0o700)
      await fresh.goto(origin)
      const incidentLink = fresh.getByRole('link', {name: /proof\.txt needs attention/})
      const incident = await incidentLink.getAttribute('href')
      expect(incident).toMatch(/^\/work\/[a-f0-9]{32}$/)
      await incidentLink.click()
      await expect(fresh).toHaveURL(origin + incident)
      await expect(fresh.getByText('Resolved, recovery verified', {exact: true})).toBeVisible()
      await expect(fresh.getByText('Independent file inspection confirmed mode 700.').first()).toBeVisible()
      const sameGoal = await fresh.getByRole('link', {name: 'Open standing goal'}).getAttribute('href')
      await fresh.locator('a[href^="/skills/fixture-mode?rev="]').first().click()
      await expect(fresh.getByRole('heading', {name: 'Maintain fixture mode'})).toBeVisible()
      await fresh.goto(origin + sameGoal)
      await expect(fresh.getByText('Keep proof.txt at mode 700', {exact: true})).toBeVisible()
      console.log('Standing goal and recovery evidence', {goal: sameGoal, incident})
    }
  } finally {
    await context.close()
    for (const child of children.reverse()) await stop(child)
    for (const id of owned) {
      const matching = docker('container', 'ls', '-aq', '--filter', 'label=' + owner, '--filter', 'id=' + id)
      if (matching) docker('container', 'rm', '-f', id)
    }
  }
})
