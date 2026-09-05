import type { Repo } from './repo'
import { newSheet, SYSTEM_COLUMNS } from '../crdt/doc'
import { orderAfter } from '../util/order'
import { ulid } from '../util/ids'
import type { Row } from '../model/types'

/**
 * The sample folder every new account starts with.
 *
 * It exists to teach the model of the app by example - a folder holding files,
 * a file holding rows, a custom column beyond the three defaults, and a period
 * switched on - rather than by a tour. It is marked `sample: true` so the UI can
 * label it and offer one-click removal.
 */
export async function seedSampleFolder(repo: Repo): Promise<void> {
  const folder = await repo.createFolder({ name: 'Sample: October trip', color: '#0f766e', icon: '🧭', sample: true })

  const qtyCol = { id: 'c_qty', name: 'Quantity', kind: 'number' as const, order: 'd0' }
  const payCol = { id: 'c_pay', name: 'Paid via', kind: 'select' as const, options: ['UPI', 'Cash', 'Card'], order: 'e0' }
  const receiptCol = { id: 'c_receipt', name: 'Receipt', kind: 'attachment' as const, order: 'f0' }

  const doc = newSheet({ folderId: folder.id, ownerId: 'seed', name: 'Trip expenses' })
  doc.columns.push(qtyCol, payCol, receiptCol)
  doc.duration = { enabled: true, mode: 'date', from: '2025-10-04', to: '2025-10-09' }

  const samples: Array<[number, string, string, number, string]> = [
    [4820, 'Train tickets', 'Return, sleeper class', 2, 'UPI'],
    [1250, 'Hotel, night 1', 'Includes breakfast', 1, 'Card'],
    [1250, 'Hotel, night 2', '', 1, 'Card'],
    [640, 'Dinner at the pier', 'Split between 3 of us', 3, 'Cash'],
    [180, 'Local bus passes', 'Day pass', 2, 'Cash'],
    [2300, 'Boat tour', 'Booked ahead, 10% off applied', 2, 'UPI'],
    [95, 'Coffee', '', 1, 'UPI'],
  ]

  let order: string | null = null
  const rows: Row[] = samples.map(([amount, title, notes, qty, pay]) => {
    order = orderAfter(order)
    const now = Date.now()
    return {
      id: ulid(),
      order,
      createdAt: now,
      updatedAt: now,
      cells: {
        [SYSTEM_COLUMNS.amount]: amount,
        [SYSTEM_COLUMNS.title]: title,
        [SYSTEM_COLUMNS.notes]: notes,
        [qtyCol.id]: qty,
        [payCol.id]: pay,
        [receiptCol.id]: [],
      },
    }
  })
  doc.rows = rows
  doc.rev = 1

  await repo.createFile({ folderId: folder.id, name: doc.name, id: doc.id, seed: doc })

  const second = newSheet({ folderId: folder.id, ownerId: 'seed', name: 'Souvenirs' })
  second.rows = [
    row(second.columns[0].id, second.columns[1].id, second.columns[2].id, 'a0', 450, 'Postcards & prints', 'For the wall'),
    row(second.columns[0].id, second.columns[1].id, second.columns[2].id, 'b0', 1600, 'Ceramic bowl', 'Wrapped, fragile'),
  ]
  second.rev = 1
  await repo.createFile({ folderId: folder.id, name: second.name, id: second.id, seed: second })
}

function row(amountId: string, titleId: string, notesId: string, order: string, amount: number, title: string, notes: string): Row {
  const now = Date.now()
  return { id: ulid(), order, createdAt: now, updatedAt: now, cells: { [amountId]: amount, [titleId]: title, [notesId]: notes } }
}

