import { createFileRoute } from '@tanstack/react-router'
import { Component, type ErrorInfo, type ReactNode, useCallback, useEffect, useState } from 'react'

export const Route = createFileRoute('/')({
  component: HomeBillSplitterPage,
})

interface HomeSummary {
  id: string
  name: string
  createdAt?: string
}

interface Member {
  id: string
  homeId: string
  name: string
}

interface Balance {
  memberId: string
  name: string
  outstandingCents: number
}

interface Share {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}

interface Bill {
  id: string
  homeId: string
  title: string
  totalCents: number
  createdAt: string
  shares: Share[]
}

// Format cents into dollar string, e.g. 1050 -> "$10.50"
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

// Format date timestamp
function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString)
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return isoString
  }
}

// Safe fetch wrapper with timeout and JSON error extraction
async function safeFetch<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10000,
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    })
    clearTimeout(timeoutId)

    let parsed: unknown = null
    const text = await response.text()
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }

    if (!response.ok) {
      const errorMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP error ${response.status}: ${response.statusText || 'Request failed'}`
      return { ok: false, status: response.status, error: errorMsg }
    }

    return { ok: true, status: response.status, data: parsed as T }
  } catch (err: unknown) {
    clearTimeout(timeoutId)
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        ok: false,
        status: 408,
        error: 'Request timed out. The server is responding too slowly.',
      }
    }
    const message = err instanceof Error ? err.message : 'Network error or unable to reach server'
    return { ok: false, status: 0, error: message }
  }
}

// React Error Boundary to prevent page crashes
interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class SafeErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Captured in SafeErrorBoundary:', error, errorInfo)
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="container" style={{ paddingTop: 40 }}>
          <div className="alert alert-danger">
            <div>
              <strong>Application Error:</strong>{' '}
              {this.state.error?.message || 'Something went wrong.'}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function HomeBillSplitterPage() {
  return (
    <SafeErrorBoundary>
      <BillSplitterApp />
    </SafeErrorBoundary>
  )
}

function BillSplitterApp() {
  const [homes, setHomes] = useState<HomeSummary[]>([])
  const [selectedHomeId, setSelectedHomeId] = useState<string>('')
  const [members, setMembers] = useState<Member[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [bills, setBills] = useState<Bill[]>([])

  // Loading & Error States
  const [isLoadingHomes, setIsLoadingHomes] = useState(true)
  const [isLoadingHomeData, setIsLoadingHomeData] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [payingShareId, setPayingShareId] = useState<string | null>(null)
  const [paymentError, setPaymentError] = useState<{ shareId: string; message: string } | null>(
    null,
  )

  // Forms
  const [newHomeName, setNewHomeName] = useState('')
  const [isCreatingHome, setIsCreatingHome] = useState(false)
  const [newMemberName, setNewMemberName] = useState('')
  const [isAddingMember, setIsAddingMember] = useState(false)
  const [billTitle, setBillTitle] = useState('')
  const [billAmount, setBillAmount] = useState('')
  const [isCreatingBill, setIsCreatingBill] = useState(false)
  const [billFormError, setBillFormError] = useState<string | null>(null)

  const loadHomes = useCallback(async () => {
    setIsLoadingHomes(true)
    setPageError(null)
    const result = await safeFetch<{ homes: HomeSummary[] }>('/api/homes')
    setIsLoadingHomes(false)

    if (!result.ok) {
      setPageError(result.error || 'Failed to load homes from server.')
      return
    }

    const loadedHomes = result.data?.homes || []
    setHomes(loadedHomes)
    if (loadedHomes.length > 0 && !selectedHomeId) {
      setSelectedHomeId(loadedHomes[0]?.id || '')
    }
  }, [selectedHomeId])

  const loadHomeDetails = useCallback(async (homeId: string) => {
    setIsLoadingHomeData(true)
    setPageError(null)

    const [membersRes, balancesRes, billsRes] = await Promise.all([
      safeFetch<{ id: string; name: string; members: Member[] }>(`/api/homes/${homeId}`),
      safeFetch<{ balances: Balance[] }>(`/api/homes/${homeId}/balances`),
      safeFetch<{ bills: Bill[] }>(`/api/homes/${homeId}/bills`),
    ])

    setIsLoadingHomeData(false)

    if (!membersRes.ok) {
      setPageError(membersRes.error || 'Failed to load home details.')
      return
    }
    if (!balancesRes.ok) {
      setPageError(balancesRes.error || 'Failed to load balances.')
      return
    }
    if (!billsRes.ok) {
      setPageError(billsRes.error || 'Failed to load bills.')
      return
    }

    setMembers(membersRes.data?.members || [])
    setBalances(balancesRes.data?.balances || [])
    setBills(billsRes.data?.bills || [])
  }, [])

  // Load homes on initial mount
  useEffect(() => {
    loadHomes()
  }, [loadHomes])

  // Load details whenever selected home changes
  useEffect(() => {
    if (selectedHomeId) {
      loadHomeDetails(selectedHomeId)
    } else {
      setMembers([])
      setBalances([])
      setBills([])
    }
  }, [selectedHomeId, loadHomeDetails])

  async function handleCreateHome(e: React.FormEvent) {
    e.preventDefault()
    const name = newHomeName.trim()
    if (!name) return

    setIsCreatingHome(true)
    setPageError(null)

    const res = await safeFetch<{ id: string; name: string }>('/api/homes', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })

    setIsCreatingHome(false)
    if (!res.ok || !res.data) {
      setPageError(res.error || 'Failed to create home.')
      return
    }

    setNewHomeName('')
    const created = res.data
    setHomes((prev) => [created, ...prev])
    setSelectedHomeId(created.id)
  }

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault()
    const name = newMemberName.trim()
    if (!name || !selectedHomeId) return

    setIsAddingMember(true)
    setPageError(null)

    const res = await safeFetch<Member>(`/api/homes/${selectedHomeId}/members`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })

    setIsAddingMember(false)
    if (!res.ok || !res.data) {
      setPageError(res.error || 'Failed to add member.')
      return
    }

    setNewMemberName('')
    await loadHomeDetails(selectedHomeId)
  }

  async function handleCreateBill(e: React.FormEvent) {
    e.preventDefault()
    setBillFormError(null)

    const title = billTitle.trim()
    if (!title) {
      setBillFormError('Bill title cannot be empty.')
      return
    }

    if (members.length === 0) {
      setBillFormError('Cannot create a bill for a home with no members. Add members first.')
      return
    }

    const numericAmount = Number(billAmount)
    if (!billAmount || Number.isNaN(numericAmount) || numericAmount <= 0) {
      setBillFormError('Total amount must be a positive number.')
      return
    }

    // Convert dollars to cents (integer)
    const totalCents = Math.round(numericAmount * 100)
    if (totalCents <= 0) {
      setBillFormError('Total cents must be greater than zero.')
      return
    }

    setIsCreatingBill(true)
    const res = await safeFetch<Bill>(`/api/homes/${selectedHomeId}/bills`, {
      method: 'POST',
      body: JSON.stringify({ title, totalCents }),
    })

    setIsCreatingBill(false)
    if (!res.ok) {
      setBillFormError(res.error || 'Failed to create bill.')
      return
    }

    setBillTitle('')
    setBillAmount('')
    await loadHomeDetails(selectedHomeId)
  }

  async function handlePayShare(billId: string, shareId: string) {
    setPaymentError(null)
    setPayingShareId(shareId)

    // Generate unique idempotency key for this payment attempt
    const idempotencyKey = crypto.randomUUID()

    const res = await safeFetch<Share>(`/api/bills/${billId}/shares/${shareId}/pay`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
    })

    setPayingShareId(null)

    if (!res.ok || !res.data) {
      // Payment failed: keep share unpaid and display clear error message
      setPaymentError({
        shareId,
        message: res.error || 'Payment failed. The share remains unpaid.',
      })
      return
    }

    const paidShare = res.data

    // Optimistically update the share in local state
    setBills((prevBills) =>
      prevBills.map((b) => {
        if (b.id !== billId) return b
        return {
          ...b,
          shares: b.shares.map((s) => (s.id === shareId ? { ...s, paidAt: paidShare.paidAt } : s)),
        }
      }),
    )

    // Refresh balances from the server
    if (selectedHomeId) {
      const balRes = await safeFetch<{ balances: Balance[] }>(
        `/api/homes/${selectedHomeId}/balances`,
      )
      if (balRes.ok && balRes.data) {
        setBalances(balRes.data.balances)
      }
    }
  }

  // Calculate live preview for bill split
  const livePreview = (() => {
    const num = Number(billAmount)
    if (Number.isNaN(num) || num <= 0 || members.length === 0) return null
    const cents = Math.round(num * 100)
    const base = Math.floor(cents / members.length)
    const remainder = cents % members.length
    return members.map((m, i) => ({
      memberId: m.id,
      name: m.name,
      amountCents: base + (i < remainder ? 1 : 0),
    }))
  })()

  return (
    <main className="container">
      {/* Header */}
      <header className="header">
        <h1>
          <span>🏡</span> Shared Bill Splitter
        </h1>
        <p>Fair, safe, and transparent bill splitting for shared homes</p>
      </header>

      {/* Global Error Alert */}
      {pageError && (
        <div className="alert alert-danger">
          <div>
            <strong>Error:</strong> {pageError}
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => selectedHomeId && loadHomeDetails(selectedHomeId)}
          >
            Retry
          </button>
        </div>
      )}

      {/* Home Selector Bar */}
      <section className="card">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div style={{ flex: '1 1 240px' }}>
            <label
              htmlFor="home-select"
              style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}
            >
              Selected Home:
            </label>
            {isLoadingHomes ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <span className="loading-spinner" /> Loading homes...
              </div>
            ) : homes.length === 0 ? (
              <div style={{ marginTop: 6, color: '#64748b', fontSize: 14 }}>
                No homes available. Create one below!
              </div>
            ) : (
              <select
                id="home-select"
                className="select"
                style={{ marginTop: 6 }}
                value={selectedHomeId}
                onChange={(e) => setSelectedHomeId(e.target.value)}
              >
                {homes.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <form
            onSubmit={handleCreateHome}
            style={{ display: 'flex', gap: 8, flex: '1 1 280px', alignItems: 'flex-end' }}
          >
            <div style={{ flex: 1 }}>
              <label
                htmlFor="new-home-name"
                style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}
              >
                New Home Name:
              </label>
              <input
                id="new-home-name"
                type="text"
                className="input"
                style={{ marginTop: 6 }}
                placeholder="e.g. Flat 4B"
                value={newHomeName}
                onChange={(e) => setNewHomeName(e.target.value)}
                disabled={isCreatingHome}
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isCreatingHome || !newHomeName.trim()}
            >
              {isCreatingHome ? <span className="loading-spinner" /> : 'Create'}
            </button>
          </form>
        </div>
      </section>

      {/* Main Home Details */}
      {!selectedHomeId ? (
        <div className="card empty-state">
          <div className="empty-state-icon">🏘️</div>
          <h3>No Home Selected</h3>
          <p>Please create or select a home to view members and bills.</p>
        </div>
      ) : isLoadingHomeData ? (
        <div className="card empty-state">
          <span className="loading-spinner" style={{ width: 32, height: 32 }} />
          <p style={{ marginTop: 12 }}>Loading home information...</p>
        </div>
      ) : (
        <>
          {/* Members & Balances Grid */}
          <div className="grid-2">
            {/* Members Card */}
            <div className="card">
              <h2 className="card-title">
                <span>Members ({members.length})</span>
                <span style={{ fontSize: 12, fontWeight: 400, color: '#64748b' }}>
                  Ordered by addition order
                </span>
              </h2>

              {members.length === 0 ? (
                <div className="empty-state" style={{ padding: '20px 0' }}>
                  <p>No members added to this home yet.</p>
                  <p style={{ fontSize: 13, marginTop: 4 }}>
                    Add members before creating bills to enable fair splitting.
                  </p>
                </div>
              ) : (
                <ul style={{ listStyle: 'none', marginBottom: 16 }}>
                  {members.map((member, idx) => (
                    <li
                      key={member.id}
                      style={{
                        padding: '8px 12px',
                        borderBottom: '1px solid #f1f5f9',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span style={{ fontWeight: 500 }}>
                        <span style={{ color: '#94a3b8', marginRight: 8 }}>#{idx + 1}</span>
                        {member.name}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Add Member Form */}
              <form onSubmit={handleAddMember} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <input
                  type="text"
                  className="input"
                  placeholder="New member name (e.g. Asha)"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  disabled={isAddingMember}
                />
                <button
                  type="submit"
                  className="btn btn-secondary"
                  disabled={isAddingMember || !newMemberName.trim()}
                >
                  {isAddingMember ? <span className="loading-spinner" /> : 'Add'}
                </button>
              </form>
            </div>

            {/* Balances Card */}
            <div className="card">
              <h2 className="card-title">
                <span>Outstanding Balances</span>
              </h2>

              {balances.length === 0 ? (
                <div className="empty-state" style={{ padding: '20px 0' }}>
                  <p>No member balances to display.</p>
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th style={{ textAlign: 'right' }}>Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balances.map((b) => (
                      <tr key={b.memberId}>
                        <td style={{ fontWeight: 500 }}>{b.name}</td>
                        <td
                          style={{
                            textAlign: 'right',
                            fontWeight: 600,
                            color: b.outstandingCents > 0 ? '#b45309' : '#15803d',
                          }}
                        >
                          {formatCents(b.outstandingCents)}
                          {b.outstandingCents === 0 && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 11,
                                color: '#16a34a',
                              }}
                            >
                              (Settled)
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Create Bill Card */}
          <div className="card">
            <h2 className="card-title">Add a Bill to Split</h2>

            {billFormError && (
              <div className="alert alert-danger" style={{ marginBottom: 16 }}>
                <div>{billFormError}</div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setBillFormError(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            {members.length === 0 ? (
              <div className="alert alert-warning">
                <strong>Cannot add bills:</strong> This home currently has no members. Add at least
                one member to enable bill splitting.
              </div>
            ) : (
              <form onSubmit={handleCreateBill}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 14 }}>
                  <div style={{ flex: '2 1 200px' }}>
                    <label
                      htmlFor="bill-title"
                      style={{ fontSize: 13, fontWeight: 500, color: '#334155' }}
                    >
                      Bill Title:
                    </label>
                    <input
                      id="bill-title"
                      type="text"
                      className="input"
                      placeholder="e.g. WiFi, Groceries, Electricity"
                      value={billTitle}
                      onChange={(e) => setBillTitle(e.target.value)}
                      disabled={isCreatingBill}
                    />
                  </div>

                  <div style={{ flex: '1 1 140px' }}>
                    <label
                      htmlFor="bill-amount"
                      style={{ fontSize: 13, fontWeight: 500, color: '#334155' }}
                    >
                      Total Amount ($):
                    </label>
                    <input
                      id="bill-amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      className="input"
                      placeholder="e.g. 30.00"
                      value={billAmount}
                      onChange={(e) => setBillAmount(e.target.value)}
                      disabled={isCreatingBill}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={isCreatingBill || !billTitle.trim() || !billAmount}
                    >
                      {isCreatingBill ? <span className="loading-spinner" /> : 'Split Bill'}
                    </button>
                  </div>
                </div>

                {/* Live Split Preview */}
                {livePreview && livePreview.length > 0 && (
                  <div
                    style={{
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: 6,
                      padding: 12,
                      fontSize: 13,
                    }}
                  >
                    <div style={{ fontWeight: 600, color: '#475569', marginBottom: 6 }}>
                      Live Split Preview:
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                      {livePreview.map((item) => (
                        <div
                          key={item.memberId}
                          style={{
                            background: '#fff',
                            border: '1px solid #cbd5e1',
                            padding: '4px 8px',
                            borderRadius: 4,
                          }}
                        >
                          <span style={{ fontWeight: 500 }}>{item.name}:</span>{' '}
                          <span style={{ fontWeight: 600, color: '#2563eb' }}>
                            {formatCents(item.amountCents)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p style={{ marginTop: 6, fontSize: 11, color: '#64748b' }}>
                      Shares always add up exactly to the total. Extra cents are allocated to the
                      first members in order of addition.
                    </p>
                  </div>
                )}
              </form>
            )}
          </div>

          {/* Payment Error Alert */}
          {paymentError && (
            <div className="alert alert-danger">
              <div>
                <strong>Payment Error:</strong> {paymentError.message}
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setPaymentError(null)}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Bills & Shares Section */}
          <section className="card">
            <h2 className="card-title">
              <span>Bills & Shares</span>
              <span style={{ fontSize: 13, fontWeight: 400, color: '#64748b' }}>
                {bills.length} {bills.length === 1 ? 'bill' : 'bills'}
              </span>
            </h2>

            {bills.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🧾</div>
                <h3>No Bills Yet</h3>
                <p>Add a bill above to split it among members.</p>
              </div>
            ) : (
              <div>
                {bills.map((bill) => (
                  <article key={bill.id} className="bill-card">
                    <div className="bill-header">
                      <div>
                        <div className="bill-title">{bill.title}</div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                          Created on {formatDate(bill.createdAt)}
                        </div>
                      </div>
                      <div className="bill-total">{formatCents(bill.totalCents)}</div>
                    </div>

                    {/* Shares list */}
                    <div style={{ marginTop: 12 }}>
                      <div
                        style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}
                      >
                        Member Shares ({bill.shares.length}):
                      </div>
                      {bill.shares.map((share) => {
                        const isPaying = payingShareId === share.id
                        const isPaid = share.paidAt !== null

                        return (
                          <div key={share.id} className="share-row">
                            <div className="share-info">
                              <span className="share-member">{share.memberName}</span>
                              <span className="share-amount">{formatCents(share.amountCents)}</span>
                              {isPaid ? (
                                <span className="badge badge-paid">
                                  ✓ Paid ({share.paidAt ? formatDate(share.paidAt) : 'Yes'})
                                </span>
                              ) : (
                                <span className="badge badge-unpaid">Pending Payment</span>
                              )}
                            </div>

                            <div>
                              {!isPaid ? (
                                <button
                                  type="button"
                                  className="btn btn-success btn-sm"
                                  onClick={() => handlePayShare(bill.id, share.id)}
                                  disabled={isPaying}
                                >
                                  {isPaying ? (
                                    <>
                                      <span className="loading-spinner" /> Paying...
                                    </>
                                  ) : (
                                    'Pay Share'
                                  )}
                                </button>
                              ) : (
                                <span
                                  style={{
                                    fontSize: 12,
                                    color: '#16a34a',
                                    fontWeight: 500,
                                  }}
                                >
                                  Settled
                                </span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  )
}
