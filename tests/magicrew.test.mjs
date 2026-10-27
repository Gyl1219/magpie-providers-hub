// magicrew 渠道协议测试：登录 / 签发续期 / 积分窗口 / 模型映射。
// 全部 mock fetch，不真发网络请求。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { magicrewChannel, magicrewIntlChannel, SITES, makeChannel } = await import('../src/magicrew.mjs')

/** 装一个可编排的 fetch 探针 */
function withFetch(handler, fn) {
  const orig = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body })
    const r = await handler(String(url), init)
    return {
      ok: r.status === undefined || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.body ?? {}),
      headers: new Headers(),
    }
  }
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = orig })
}

test('两个渠道导出自洽（cn / intl 独立 id）', () => {
  assert.equal(magicrewChannel.id, 'magicrew')
  assert.equal(magicrewIntlChannel.id, 'magicrew-intl')
  assert.notEqual(magicrewChannel.displayName, magicrewIntlChannel.displayName)
  for (const ch of [magicrewChannel, magicrewIntlChannel]) {
    for (const m of ['beginLogin', 'refresh', 'usage', 'chat', 'checkin', 'catalog']) {
      assert.equal(typeof ch[m], 'function', `${ch.id} 缺 ${m}`)
    }
  }
})

test('登录：POST /api/v1/sessions，字段兼容 token/access_token/jwt', async () => {
  await withFetch(
    () => ({ body: { code: 1000, data: { token: 'JWT-ABC', organization_code: 'ORG-1', name: '老张' } } }),
    async (calls) => {
      const r = await magicrewChannel._login({ site: SITES.cn, phone: '138 0013 8000', password: 'pw' })
      assert.equal(r.token, 'JWT-ABC')
      assert.equal(r.organizationCode, 'ORG-1')
      assert.equal(r.nickname, '老张')
      assert.match(calls[0].url, /\/api\/v1\/sessions$/)
      assert.equal(calls[0].method, 'POST')
      const sent = JSON.parse(calls[0].body)
      assert.equal(sent.phone, '13800138000', '手机号去掉非数字')
      assert.equal(sent.type, 'phone_password')
    },
  )
})

test('登录：拿不到 token 抛错', async () => {
  await withFetch(() => ({ body: { code: 1000, data: {} } }), async () => {
    await assert.rejects(
      () => magicrewChannel._login({ site: SITES.cn, phone: '1', password: 'p' }),
      /没拿到 token/,
    )
  })
})

test('签发 api_key：POST model-gateway/tokens + 带 organization-code 头', async () => {
  await withFetch(
    () => ({ body: { code: 1000, data: { api_key: 'mgw_x', refresh_token: 'rt_1', api_key_expires_at: 123 } } }),
    async (calls) => {
      const gw = await magicrewChannel._issueGatewayKey(SITES.cn, { token: 'J', organizationCode: 'ORG' })
      assert.equal(gw.apiKey, 'mgw_x')
      assert.equal(gw.refreshToken, 'rt_1')
      assert.match(calls[0].url, /\/api\/v1\/model-gateway\/tokens$/)
      assert.equal(calls[0].method, 'POST')
    },
  )
})

test('续期 api_key：PUT model-gateway/tokens，refresh_token 轮换', async () => {
  await withFetch(
    () => ({ body: { code: 1000, data: { api_key: 'mgw_new', refresh_token: 'rt_2' } } }),
    async (calls) => {
      const gw = await magicrewChannel._refreshGatewayKey(SITES.cn, { refreshToken: 'rt_1' })
      assert.equal(gw.apiKey, 'mgw_new')
      assert.equal(gw.refreshToken, 'rt_2', 'refresh_token 已轮换')
      assert.equal(calls[0].method, 'PUT')
      assert.equal(JSON.parse(calls[0].body).refresh_token, 'rt_1')
    },
  )
})

test('usage：滚动指针分档（临期=最早到期未耗尽桶，名字带档位）', async () => {
  const eod = new Date(); eod.setHours(23, 59, 59, 0)
  const eodStr = `${eod.getFullYear()}-${String(eod.getMonth()+1).padStart(2,'0')}-${String(eod.getDate()).padStart(2,'0')} 23:59:59`
  const later = new Date(Date.now() + 10 * 86_400_000)
  const laterStr = `${later.getFullYear()}-${String(later.getMonth()+1).padStart(2,'0')}-${String(later.getDate()).padStart(2,'0')} 12:00:00`
  await withFetch(
    () => ({ body: { code: 1000, data: { total_points: 1200, expiring_quota_details: [
      { remaining_points: 200, expires_at: eodStr },
      { remaining_points: 1000, expires_at: laterStr },
    ] } } }),
    async () => {
      const windows = await magicrewChannel.usage({ token: 'J', organizationCode: 'O' })
      const pointer = windows.find((w) => /临期/.test(w.name))
      assert.ok(pointer, '应有临期桶（滚动指针）')
      assert.match(pointer.name, /每日赠送/)
      assert.match(pointer.display, /剩余 200/)
      const longterm = windows.find((w) => /长期/.test(w.name))
      assert.ok(longterm, '另一个到期桶应为长期')
      assert.match(longterm.display, /剩余 1000/)
    },
  )
})

test('usage：无到期余额出永久桶；剩 0 出已耗尽桶（aside）', async () => {
  const later = new Date(Date.now() + 5 * 86_400_000)
  const laterStr = `${later.getFullYear()}-${String(later.getMonth()+1).padStart(2,'0')}-${String(later.getDate()).padStart(2,'0')} 12:00:00`
  await withFetch(
    () => ({ body: { code: 1000, data: { total_points: 1500, expiring_quota_details: [
      { remaining_points: 0, expires_at: laterStr },
      { remaining_points: 1000, expires_at: laterStr },
    ] } } }),
    async () => {
      const windows = await magicrewChannel.usage({ token: 'J', organizationCode: 'O' })
      const permanent = windows.find((w) => /永久/.test(w.name))
      assert.ok(permanent, '应有永久桶')
      assert.match(permanent.display, /剩余 500/)
      const spent = windows.find((w) => /已耗尽/.test(w.name))
      assert.ok(spent, '应有已耗尽桶')
      assert.equal(spent.aside, true)
    },
  )
})

test('usage：401 → 提示重新登录（不炸）', async () => {
  await withFetch(() => ({ status: 401, body: { message: 'token expired' } }), async () => {
    const windows = await magicrewChannel.usage({ token: 'J', organizationCode: 'O' })
    assert.equal(windows.length, 1)
    assert.match(windows[0].display, /重新登录|失效/)
  })
})

test('模型映射：/api/v1/flows/models → { id, name, vision }', async () => {
  await withFetch(
    () => ({ body: { code: 1000, data: { models: [{ value: 'glm-5.3', label: 'GLM 5.3', vision: true }, { value: 'kimi-k3' }] } } }),
    async (calls) => {
      const models = await magicrewChannel._fetchModels(SITES.cn, { token: 'J', organizationCode: 'O' })
      assert.match(calls[0].url, /\/api\/v1\/flows\/models$/)
      assert.deepEqual(models[0], { id: 'glm-5.3', name: 'GLM 5.3', vision: true })
      assert.deepEqual(models[1], { id: 'kimi-k3', name: 'kimi-k3', vision: false })
    },
  )
})

test('refresh：api_key 未过期时原样返回（不瞎续）', async () => {
  const credential = {
    token: 'J', organizationCode: 'O',
    apiKey: 'mgw_alive', refreshToken: 'rt', apiKeyExpiresAt: Date.now() + 3600_000,
  }
  await withFetch(() => { throw new Error('不该发请求') }, async () => {
    const next = await magicrewChannel.refresh(credential)
    assert.equal(next.apiKey, 'mgw_alive')
  })
})

test('refresh：api_key 将过期时用 refresh_token 换新', async () => {
  const credential = {
    token: 'J', organizationCode: 'O',
    apiKey: 'mgw_old', refreshToken: 'rt_old', apiKeyExpiresAt: Date.now() + 60_000,
  }
  await withFetch(
    () => ({ body: { code: 1000, data: { api_key: 'mgw_new', refresh_token: 'rt_new' } } }),
    async () => {
      const next = await magicrewChannel.refresh(credential)
      assert.equal(next.apiKey, 'mgw_new')
      assert.equal(next.refreshToken, 'rt_new')
    },
  )
})

test('makeChannel 可对任意站点造渠道（intl host 正确）', () => {
  const ch = makeChannel(SITES.intl)
  assert.equal(ch.id, 'magicrew-intl')
  assert.match(SITES.intl.host, /magicrew\.ai/)
})

test('签到：领到每日登录 + 完成新手任务 → claimed + 净增积分', async () => {
  let points = 2200
  await withFetch(
    (url, init = {}) => {
      if (url.includes('/api/v1/quota/points/total')) return { body: { code: 1000, data: { total_points: points } } }
      if (url.includes('/api/v1/login-gift')) { points += 200; return { body: { code: 1000, data: { granted: true, point_amount: 200, message: '成功领取每日登录积分' } } } }
      if (url.includes('/api/v1/onboarding/tasks')) return { body: { code: 1000, data: { tasks: [
        { code: 'first_ai_work', title: '完成第一次 AI 工作', points: 100, status: 'PENDING', reward_status: null },
      ] } } }
      if (url.includes('/completion')) return { body: { code: 1000, data: { points: 100 } } }
      return { body: { code: 1000, data: {} } }
    },
    async (calls) => {
      const r = await magicrewChannel.checkin({ token: 'J', organizationCode: 'O' })
      assert.equal(r.outcome, 'claimed')
      assert.equal(r.credit, 200)
      assert.match(r.message, /每日登录 \+200/)
      assert.match(r.message, /需手动/, 'first_ai_work 精简版不做（需手动）')
      // 请求了 login-gift 与 onboarding/tasks，但**没有** PUT first_ai_work
      const put = calls.filter((c) => c.method === 'PUT')
      assert.equal(put.length, 0, '精简版不替账号发消息（first_ai_work 不 PUT）')
    },
  )
})

test('签到：每日登录已领过 + 无新手任务 → done（幂等，无 credit）', async () => {
  await withFetch(
    (url) => {
      if (url.includes('/api/v1/quota/points/total')) return { body: { code: 1000, data: { total_points: 2200 } } }
      if (url.includes('/api/v1/login-gift')) return { body: { code: 1000, data: { granted: false, point_amount: 0, message: '今日已领取登录积分' } } }
      if (url.includes('/api/v1/onboarding/tasks')) return { body: { code: 1000, data: { tasks: [] } } }
      return { body: { code: 1000, data: {} } }
    },
    async () => {
      const r = await magicrewChannel.checkin({ token: 'J', organizationCode: 'O' })
      assert.equal(r.outcome, 'claimed', '今日的赠送已入账 → 成功（done/inactive 会被 magpie 渲染成黄/灰「稍后再问」）')
      assert.equal(r.credit, 200, '今日已入账的每日赠送（国内 200）')
      assert.match(r.message, /每日登录已领过/)
      assert.match(r.message, /无新手任务/)
    },
  )
})

test('签到：读不到积分 → failed（起点都没有，谈不上签到）', async () => {
  await withFetch(
    () => ({ status: 401, body: { message: 'token expired' } }),
    async () => {
      const r = await magicrewChannel.checkin({ token: 'J', organizationCode: 'O' })
      assert.equal(r.outcome, 'failed')
      assert.match(r.message, /读不到积分/)
    },
  )
})

test('usage：长期多批合并成一个窗口（共 K 批 · 最早到期）', async () => {
  const later = (d) => {
    const t = new Date(Date.now() + d * 86_400_000)
    return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')} 12:00:00`
  }
  await withFetch(
    () => ({ body: { code: 1000, data: { total_points: 1350, expiring_quota_details: [
      { remaining_points: 1000, expires_at: later(6) },
      { remaining_points: 50, expires_at: later(29) },
      { remaining_points: 50, expires_at: later(29) },
      { remaining_points: 50, expires_at: later(29) },
      { remaining_points: 50, expires_at: later(29) },
      { remaining_points: 50, expires_at: later(29) },
      { remaining_points: 50, expires_at: later(29) },
      { remaining_points: 50, expires_at: later(29) },
    ] } } }),
    async () => {
      const windows = await magicrewChannel.usage({ token: 'J', organizationCode: 'O' })
      // 指针 = 最早的 1000；其余 7 批合并成一个长期窗口
      const longs = windows.filter((w) => /长期/.test(w.name))
      assert.equal(longs.length, 1, '长期包必须合并成一个窗口（真机报障：一屏黄胶囊）')
      assert.match(longs[0].display, /剩余 350/)
      assert.match(longs[0].display, /共 7 批/)
      assert.match(longs[0].display, /最早 \d{2}-\d{2} 到期/)
    },
  )
})
