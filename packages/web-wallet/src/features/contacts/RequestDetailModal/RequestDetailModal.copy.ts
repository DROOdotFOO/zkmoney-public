export default {
  status: {
    pending: "Unpaid",
    fulfilled: "Completed",
    declined: "Declined",
    cancelled: "Cancelled",
  },
  cancel: {
    title: "Cancel request?",
    cancelling: "Cancelling…",
    action: "Cancel request",
    done: "Request cancelled",
  },
  title: "Request",
  handle: "{handle}.zk.money",
  viaPaylink: "Via paylink",
  rows: {
    type: "Type",
    receive: "Receive",
    amount: "Amount",
    note: "Note",
    date: "Request date",
    hash: "Tx hash",
    status: "Status",
  },
} as const
