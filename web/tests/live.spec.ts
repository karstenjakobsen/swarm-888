import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { freePort, stop } from './processes'

const web = resolve(process.cwd())
const root = resolve(web, '..')
const python = join(root, '.venv/bin/python')

test('private owner message survives a controller outage and replays through Caddy', async ({ page, context, request }) => {
  test.setTimeout(60_000)
  page.setDefaultTimeout(8000)
  const directory = await mkdtemp(join(tmpdir(), 'operator-ui-'))
  const webPort = await freePort()
  const controllerPort = await freePort()
  const port = await freePort()
  const origin = 'http://127.0.0.1:' + port
  const env = { ...process.env, OPERATOR_MODE: 'live', OPERATOR_STATE_DIR: directory,
    OPERATOR_ORIGIN: origin, OPERATOR_PORT: port, WEB_PORT: webPort, CONTROLLER_PORT: controllerPort,
    XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, NEXT_TELEMETRY_DISABLED: '1' }
  const children: ChildProcess[] = []
  function run(command: string, args: string[], cwd = root) {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'inherit'] })
    children.push(child)
    return child
  }
  const controller = () => run(python, ['-m', 'operator_v1.serve'])
  try {
    expect((await once(run(python, ['-m', 'operator_v1.config']), 'exit'))[0]).toBe(0)
    const firstController = controller()
    run(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', webPort], web)
    const gateway = run(process.env.CADDY || 'caddy', ['run', '--config', 'Caddyfile', '--adapter', 'caddyfile'])
    await once(gateway, 'spawn')
    await expect.poll(async () => {
      try { return (await request.get(origin + '/api/snapshot')).status() } catch { return 0 }
    }).toBe(401)
    const command = { kind:'message', text:'Confirm you received this message.', requestId:crypto.randomUUID() }
    const headers = { Origin:origin, 'X-Operator-Action':'1' }
    expect((await request.get(origin + '/api/events')).status()).toBe(401)
    expect((await request.post(origin + '/api/commands', {data:command, headers})).status()).toBe(401)
    expect((await request.get('http://127.0.0.1:' + webPort + '/api/snapshot')).status()).toBe(503)
    await page.setViewportSize({width:390, height:844})
    await page.goto(origin)
    await page.getByLabel('Owner key').fill((await readFile(join(directory, 'owner.key'),'utf8')).trim())
    await page.getByRole('button', {name:'Sign in'}).click()
    await expect(page.getByRole('heading', {name:'Morning brief'})).toBeVisible()
    expect((await page.request.post(origin + '/api/commands', {data:command, headers:{...headers, Origin:'http://elsewhere.invalid'}})).status()).toBe(403)
    expect((await (await page.request.get(origin + '/api/snapshot')).json()).cursor).toBe(0)

    // Deliver the command, lose its receipt, and retry from a freshly loaded UI.
    await page.route('**/api/commands', async route => {
      const accepted = await route.fetch()
      expect(accepted.status()).toBe(202)
      await accepted.dispose()
      await route.abort('failed')
    }, { times: 1 })
    await page.getByRole('textbox').fill(command.text)
    await page.getByRole('button', {name:'Send'}).click()
    await expect(page.getByText('Could not reach the operator.', {exact:true})).toBeVisible()
    await page.reload()
    await page.getByRole('textbox').fill(command.text)
    await page.getByRole('button', {name:'Send'}).click()
    const queued = page.getByRole('link', {name: new RegExp(command.text + ' Queued')})
    await queued.click()
    await expect(page.getByRole('heading', {name:command.text})).toBeVisible()
    await expect(page.getByText('Queued', {exact:true})).toBeVisible()
    const taskId = new URL(page.url()).pathname.split('/').at(-1)
    expect(taskId).toMatch(/^[a-f0-9]{32}$/)

    const snapshot = await (await page.request.get(origin + '/api/snapshot')).json()
    expect(snapshot.cursor).toBe(2)
    expect(snapshot.tasks).toHaveLength(1)

    const streams: string[] = []
    page.on('request', r => { if (r.resourceType() === 'eventsource') streams.push(r.url()) })
    await stop(firstController)
    expect(firstController.signalCode).not.toBe('SIGKILL')
    await expect(page.getByRole('status')).toContainText('Operator unavailable')
    const reopened = await context.newPage()
    await reopened.goto(page.url())
    await reopened.reload()
    await expect(reopened.getByRole('status')).toContainText('Operator unavailable')
    await expect(reopened.getByText('Demo', {exact:true})).toHaveCount(0)
    await expect(reopened.getByText('vps-fra-1 · kj.dev')).toHaveCount(0)

    const workerProcess = run(python, ['-m','operator_v1.worker'])
    controller()
    await expect(page.getByText('Acknowledged', {exact:true})).toBeVisible({timeout:12_000})
    await expect(reopened.getByText('Acknowledged', {exact:true})).toBeVisible()
    expect(streams.some(url => new URL(url).searchParams.get('after') === '2')).toBeTruthy()
    const timeline = page.getByRole('heading', {name:'Evidence trail'}).locator('..')
    await expect(timeline).toContainText('The worker acknowledged')
    const evidence = 'Read memory after completion.'
    expect((await once(run(python, ['-c', [
      'import sys',
      'from operator_v1.config import Settings',
      'from operator_v1.state import State',
      'state = State(Settings.load())',
      'with state.transaction(write=True) as db:',
      '    state.append(db, sys.argv[1], "evidence", sys.argv[2])',
    ].join('\n'), taskId!, evidence]), 'exit'))[0]).toBe(0)
    await expect(timeline).toContainText(evidence)
    await expect(page.getByText('Acknowledged', {exact:true})).toBeVisible()
    await expect(reopened.getByText('Acknowledged', {exact:true})).toBeVisible()
    const text = await timeline.innerText()
    await expect(reopened.getByRole('heading', {name:'Evidence trail'}).locator('..')).toHaveText(await timeline.textContent() ?? '')
    await reopened.close()
    await page.reload()
    await expect(page.getByText('Acknowledged', {exact:true})).toBeVisible()
    expect(await timeline.innerText()).toBe(text)
    await page.getByRole('link', {name:'Back to brief'}).click()
    await expect(page.locator('a[href="/work/' + taskId + '"]')).toContainText('Acknowledged')
    // Acknowledged submissions release their retry ID.
    await page.getByRole('textbox').fill(command.text)
    await page.getByRole('button', {name:'Send'}).click()
    await expect(page.getByRole('region', {name:'What happened'}).getByRole('link').filter({hasText:command.text})).toHaveCount(2)
    await page.getByRole('link', {name:'Inspect', exact:true}).click()
    await page.getByRole('link', {name:'Workers', exact:true}).click()
    const worker = page.getByRole('region', {name:'Worker status'})
    await expect(worker.getByRole('status')).toHaveText('Online')
    await expect(worker.getByText('Idle', {exact:true})).toBeVisible()
    await expect(worker.getByText('Acknowledgment', {exact:true})).toBeVisible()
    await stop(workerProcess)
    await expect(worker.getByRole('status')).toHaveText('Heartbeat stale', {timeout:40_000})
    run(python, ['-m','operator_v1.worker'])
    await expect(worker.getByRole('status')).toHaveText('Online')
  } finally {
    await context.close()
    for (const child of children.reverse()) await stop(child)
    await rm(directory, {recursive:true,force:true})
  }
})

test('fixture mode replays its own history and uses a placeholder credential', async ({ page, request }) => {
  const port = await freePort()
  const origin = 'http://127.0.0.1:' + port
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', port], {
    cwd:web, env:{...process.env, OPERATOR_MODE:'demo'}, stdio:'ignore',
  })
  try {
    await expect.poll(async () => {
      try { return (await request.get(origin + '/api/snapshot')).status() } catch { return 0 }
    }).toBe(200)
    const stale = await request.get(origin + '/api/events?after=999999')
    expect(await stale.text()).toContain('event: reset')
    expect((await request.post(origin + '/api/commands', {headers:{'Content-Type':'application/json'}, data:'null'})).status()).toBe(400)
    expect((await request.post(origin + '/api/commands', {data:{kind:'message', text:'follow up', taskId:'missing-task'}})).status()).toBe(404)
    expect((await request.post(origin + '/api/secrets', {data:{requestId:'r-s3', extra:true}})).status()).toBe(400)
    await page.goto(origin)
    await expect(page.getByRole('heading',{name:'Morning brief'})).toBeVisible()
    await expect(page.getByText('Demo',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Session menu'}).click()
    await expect(page.getByRole('menu')).toContainText(/matches a full replay of [1-9]/)
    await page.getByRole('menuitem',{name:'Replay the overnight scenario'}).click()
    await page.getByRole('button',{name:'Review credential request'}).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('input,textarea')).toHaveCount(0)
    const sent = page.waitForResponse(r => r.url() === origin + '/api/secrets')
    await dialog.getByRole('button',{name:'Use demo credential and resume'}).click()
    const reply = await sent
    expect(reply.status()).toBe(200)
    expect(reply.request().postDataJSON()).toEqual({requestId:'r-s3'})
    // Reset in another client. This tab must release its original fixture log.
    await expect(page.getByRole('button', {name:'Review credential request'})).toHaveCount(0)
    expect((await request.post(origin + '/api/commands', {data:{kind:'reset'}})).status()).toBe(200)
    await expect(page.getByRole('button', {name:'Review credential request'}).first()).toBeVisible()
    await page.goto(origin + '/work/t-api')
    await expect(page.getByRole('heading',{name:'Serve api.kj.dev over HTTPS from this VPS'})).toBeVisible()
    const skillUrl = origin + '/skills/s-https-subdomain?rev='
    await page.goto(skillUrl + 'a41f9c2')
    const verified = page.getByRole('heading', {name:'Verified on a later task'})
    await expect(verified).toBeVisible()
    await page.goto(skillUrl + '3e07b18')
    await expect(page.getByRole('heading', {name:'Procedure at 3e07b18'})).toBeVisible()
    await expect(verified).toHaveCount(0)
    await page.goto(skillUrl + 'unknown')
    await expect(page.getByText(/is not in this skill.s history/)).toBeVisible()
    await expect(page.getByRole('region', {name:'Procedure'})).toHaveCount(0)
  } finally {
    await page.close()
    await stop(server)
  }
})
