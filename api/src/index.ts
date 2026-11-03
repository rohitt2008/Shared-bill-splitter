import { Hono } from 'hono'

interface HomeRow {
  id: string
  name: string
  created_at: string
}

interface MemberRow {
  id: string
  home_id: string
  name: string
  created_at: string
}

interface BillRow {
  id: string
  home_id: string
  title: string
  total_cents: number
  created_at: string
}

interface ShareRow {
  id: string
  bill_id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
  created_at: string
}

interface BalanceResult {
  memberId: string
  name: string
  outstandingCents: number
}

interface BillShareWithMember {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}

interface BillWithShares {
  id: string
  homeId: string
  title: string
  totalCents: number
  createdAt: string
  shares: BillShareWithMember[]
}

const app = new Hono<{ Bindings: Env }>()

// Global error handlers ensuring JSON error format
app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error('Unhandled server error:', err)
  return c.json({ error: err.message || 'Internal server error' }, 500)
})

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// List all homes (used by Web UI)
app.get('/api/homes', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, created_at FROM homes ORDER BY rowid DESC',
  ).all<HomeRow>()
  return c.json({
    homes: results.map((h) => ({ id: h.id, name: h.name, createdAt: h.created_at })),
  })
})

// Create a home
app.post('/api/homes', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('name' in body) ||
    typeof (body as { name: unknown }).name !== 'string' ||
    (body as { name: string }).name.trim().length === 0
  ) {
    return c.json({ error: 'Home name is required' }, 422)
  }

  const name = (body as { name: string }).name.trim()
  const id = crypto.randomUUID()

  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

// Get home details including members
app.get('/api/homes/:homeId', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id, name, created_at FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const { results: members } = await c.env.DB.prepare(
    'SELECT id, home_id, name, created_at FROM members WHERE home_id = ? ORDER BY rowid ASC',
  )
    .bind(homeId)
    .all<MemberRow>()

  return c.json({
    id: home.id,
    name: home.name,
    createdAt: home.created_at,
    members: members.map((m) => ({ id: m.id, homeId: m.home_id, name: m.name })),
  })
})

// Add a member to a home
app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('name' in body) ||
    typeof (body as { name: unknown }).name !== 'string' ||
    (body as { name: string }).name.trim().length === 0
  ) {
    return c.json({ error: 'Member name is required' }, 422)
  }

  const name = (body as { name: string }).name.trim()
  const id = crypto.randomUUID()

  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, name)
    .run()

  return c.json({ id, homeId, name }, 201)
})

// List all bills for a home with their shares and members
app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const { results: bills } = await c.env.DB.prepare(
    'SELECT id, home_id, title, total_cents, created_at FROM bills WHERE home_id = ? ORDER BY rowid DESC',
  )
    .bind(homeId)
    .all<BillRow>()

  const { results: shares } = await c.env.DB.prepare(`
    SELECT s.id, s.bill_id, s.member_id, m.name as member_name, s.amount_cents, s.paid_at
    FROM shares s
    JOIN members m ON s.member_id = m.id
    JOIN bills b ON s.bill_id = b.id
    WHERE b.home_id = ?
    ORDER BY s.rowid ASC
  `)
    .bind(homeId)
    .all<{
      id: string
      bill_id: string
      member_id: string
      member_name: string
      amount_cents: number
      paid_at: string | null
    }>()

  const billsWithShares: BillWithShares[] = bills.map((b) => ({
    id: b.id,
    homeId: b.home_id,
    title: b.title,
    totalCents: b.total_cents,
    createdAt: b.created_at,
    shares: shares
      .filter((s) => s.bill_id === b.id)
      .map((s) => ({
        id: s.id,
        memberId: s.member_id,
        memberName: s.member_name,
        amountCents: s.amount_cents,
        paidAt: s.paid_at,
      })),
  }))

  return c.json({ bills: billsWithShares })
})

// Create a bill for a home and split it among members
app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (typeof body !== 'object' || body === null) {
    return c.json({ error: 'Request body must be an object' }, 422)
  }

  const candidate = body as { title?: unknown; totalCents?: unknown }

  if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
    return c.json({ error: 'Title must be a non-empty string' }, 422)
  }

  if (
    typeof candidate.totalCents !== 'number' ||
    !Number.isInteger(candidate.totalCents) ||
    candidate.totalCents <= 0
  ) {
    return c.json({ error: 'totalCents must be a positive integer' }, 422)
  }

  const title = candidate.title.trim()
  const totalCents = candidate.totalCents

  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string }>()

  if (members.length === 0) {
    return c.json({ error: 'Home has no members' }, 422)
  }

  const count = members.length
  const baseShare = Math.floor(totalCents / count)
  const remainder = totalCents % count

  const billId = crypto.randomUUID()
  const shares = members.map((member, index) => {
    const extra = index < remainder ? 1 : 0
    return {
      id: crypto.randomUUID(),
      memberId: member.id,
      amountCents: baseShare + extra,
      paidAt: null as string | null,
    }
  })

  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, title, totalCents),
    ...shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, billId, share.memberId, share.amountCents),
    ),
  ]

  await c.env.DB.batch(statements)

  return c.json(
    {
      id: billId,
      homeId,
      title,
      totalCents,
      shares,
    },
    201,
  )
})

// Pay a share
app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')

  const rawKey = c.req.header('Idempotency-Key')
  if (!rawKey || rawKey.trim().length === 0) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }
  const idempotencyKey = rawKey.trim()

  const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?')
    .bind(billId)
    .first<BillRow>()
  if (!bill) {
    return c.json({ error: 'Bill not found' }, 404)
  }

  const share = await c.env.DB.prepare(
    'SELECT id, bill_id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<ShareRow>()

  if (!share) {
    return c.json({ error: 'Share not found' }, 404)
  }

  // If already marked as paid
  if (share.paid_at !== null) {
    if (share.idempotency_key === idempotencyKey) {
      return c.json(
        {
          id: share.id,
          memberId: share.member_id,
          amountCents: share.amount_cents,
          paidAt: share.paid_at,
        },
        200,
      )
    }
    return c.json({ error: 'Share already paid with a different idempotency key' }, 409)
  }

  // Attempt atomic update for unpaid share
  const now = new Date().toISOString()
  const result = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  )
    .bind(now, idempotencyKey, shareId, billId)
    .run()

  if (result.meta.changes > 0) {
    return c.json(
      {
        id: share.id,
        memberId: share.member_id,
        amountCents: share.amount_cents,
        paidAt: now,
      },
      200,
    )
  }

  // Another concurrent request may have updated it
  const reloaded = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ?',
  )
    .bind(shareId)
    .first<ShareRow>()

  if (reloaded && reloaded.paid_at !== null && reloaded.idempotency_key === idempotencyKey) {
    return c.json(
      {
        id: reloaded.id,
        memberId: reloaded.member_id,
        amountCents: reloaded.amount_cents,
        paidAt: reloaded.paid_at,
      },
      200,
    )
  }

  return c.json({ error: 'Share already paid' }, 409)
})

// Get balances for a home
app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const { results } = await c.env.DB.prepare(`
    SELECT 
      m.id AS memberId,
      m.name AS name,
      COALESCE(
        (SELECT SUM(s.amount_cents)
         FROM shares s
         JOIN bills b ON s.bill_id = b.id
         WHERE s.member_id = m.id
           AND b.home_id = m.home_id
           AND s.paid_at IS NULL
        ), 0
      ) AS outstandingCents
    FROM members m
    WHERE m.home_id = ?
    ORDER BY m.rowid ASC
  `)
    .bind(homeId)
    .all<BalanceResult>()

  return c.json({ balances: results }, 200)
})

export default app
