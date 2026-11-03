import { describe, expect, it } from 'vitest'
import { type Balance, call, createBill, createHome, type Share } from './helpers'

describe('extra cases: validation & edge cases', () => {
  it('rejects empty home name', async () => {
    const res = await call('POST', '/api/homes', { body: { name: '   ' } })
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ error: expect.any(String) })
  })

  it('rejects empty member name', async () => {
    const { homeId } = await createHome([])
    const res = await call('POST', `/api/homes/${homeId}/members`, { body: { name: '' } })
    expect(res.status).toBe(422)
  })

  it('rejects bill with empty title', async () => {
    const { homeId } = await createHome(['Alice'])
    const res = await call('POST', `/api/homes/${homeId}/bills`, {
      body: { title: '   ', totalCents: 100 },
    })
    expect(res.status).toBe(422)
  })

  it('handles splitting when total cents is smaller than member count', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben', 'Chitra'])
    const res = await createBill(homeId, 1)

    expect(res.status).toBe(201)
    expect(res.body.shares.map((s) => s.amountCents)).toEqual([1, 0, 0])
    expect(res.body.shares.map((s) => s.memberId)).toEqual(members.map((m) => m.id))

    const bal = await call<{ balances: Balance[] }>('GET', `/api/homes/${homeId}/balances`)
    expect(bal.body.balances.map((b) => b.outstandingCents)).toEqual([1, 0, 0])
  })

  it('returns empty balances array for home with no members', async () => {
    const { homeId } = await createHome([])
    const res = await call<{ balances: Balance[] }>('GET', `/api/homes/${homeId}/balances`)
    expect(res.status).toBe(200)
    expect(res.body.balances).toEqual([])
  })

  it('rejects payment when share belongs to another bill', async () => {
    const { homeId } = await createHome(['Asha'])
    const bill1 = await createBill(homeId, 100)
    const bill2 = await createBill(homeId, 200)

    const share1 = bill1.body.shares[0]
    if (!share1) throw new Error('Missing share')

    // Attempt to pay share1 using bill2's ID
    const res = await call<Share>('POST', `/api/bills/${bill2.body.id}/shares/${share1.id}/pay`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
    expect(res.status).toBe(404)
  })

  it('handles concurrent payments for the same share (race condition)', async () => {
    const { homeId } = await createHome(['Asha'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('Missing share')

    const key1 = crypto.randomUUID()
    const key2 = crypto.randomUUID()

    // Fire both requests simultaneously
    const [res1, res2] = await Promise.all([
      call<Share>('POST', `/api/bills/${bill.body.id}/shares/${share.id}/pay`, {
        headers: { 'Idempotency-Key': key1 },
      }),
      call<Share>('POST', `/api/bills/${bill.body.id}/shares/${share.id}/pay`, {
        headers: { 'Idempotency-Key': key2 },
      }),
    ])

    const statuses = [res1.status, res2.status].sort()
    expect(statuses).toEqual([200, 409])

    const bal = await call<{ balances: Balance[] }>('GET', `/api/homes/${homeId}/balances`)
    expect(bal.body.balances[0]?.outstandingCents).toBe(0)
  })

  it('handles concurrent identical payments for the same share (same idempotency key)', async () => {
    const { homeId } = await createHome(['Asha'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('Missing share')

    const key = crypto.randomUUID()

    // Fire both with same key concurrently
    const [res1, res2] = await Promise.all([
      call<Share>('POST', `/api/bills/${bill.body.id}/shares/${share.id}/pay`, {
        headers: { 'Idempotency-Key': key },
      }),
      call<Share>('POST', `/api/bills/${bill.body.id}/shares/${share.id}/pay`, {
        headers: { 'Idempotency-Key': key },
      }),
    ])

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(res1.body.paidAt).toBe(res2.body.paidAt)
  })

  it('returns JSON format for not found routes', async () => {
    const res = await call('GET', '/api/some-non-existent-route')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not found' })
  })
})
