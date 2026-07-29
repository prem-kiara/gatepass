/**
 * Every user-facing string lives here.
 *
 * Keep entries short — they are read on a phone screen in sunlight, and a Tamil
 * translation of this file is the intended way to localise the app (v2). Never
 * hardcode copy in a component.
 */

export const L = {
  appName: 'GatePass',

  // --- generic ---
  loading: 'Loading…',
  save: 'Save',
  cancel: 'Cancel',
  close: 'Close',
  retry: 'Try again',
  search: 'Search',
  clear: 'Clear',
  logout: 'Log out',
  somethingWrong: 'Something went wrong.',
  noConnection: 'No connection. Check the network and try again.',
  refresh: 'Refresh',
  back: 'Back',
  next: 'Next',
  done: 'Done',
  yes: 'Yes',
  no: 'No',
  optional: 'optional',

  // --- login ---
  login: {
    title: 'GatePass',
    subtitle: 'Visitor & gate monitoring',
    username: 'Username',
    password: 'Password',
    submit: 'Log in',
    signingIn: 'Signing in…',
    failed: 'Incorrect username or password.',
  },

  // --- roles ---
  role: {
    SECURITY: 'Security',
    ADMIN: 'Admin',
    SUPERADMIN: 'Superadmin',
  },

  // --- visit status ---
  status: {
    PENDING: 'Waiting',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    INSIDE: 'Inside',
    CHECKED_OUT: 'Left',
  },

  // --- gate (security) ---
  gate: {
    title: 'Gate',
    newVisitor: '+ New Visitor',
    todaysVisitors: "Today's visitors",
    noVisitors: 'No visitors yet today.',
    noVisitorsHint: 'Tap + New Visitor when someone arrives.',

    stepPhoto: 'Photo',
    stepDetails: 'Details',
    stepMembers: 'Members',

    takePhoto: 'Take photo',
    retake: 'Retake',
    photoRequired: "A photo of the visitor is required.",
    photoHint: 'Take a clear photo of the visitor’s face.',

    fullName: 'Visitor name',
    fullNamePlaceholder: 'Full name',
    phone: 'Phone number',
    phoneHint: 'Optional — 10 digits',
    purpose: 'Purpose of visit',
    purposePlaceholder: 'e.g. Loan enquiry',
    company: 'Visiting from (company)',
    companyPlaceholder: 'e.g. Kiara Global Services',
    companyHint: 'Company or organisation the visitor represents',
    whomToVisit: 'Whom have they come to see?',
    selectHost: 'Select a person',
    otherHost: 'Other (type a name)',
    otherHostPlaceholder: 'Staff member’s name',

    repeatVisitor: 'Repeat visitor',
    repeatVisitorFound: (name: string, count: number) =>
      `${name} has visited ${count} time${count === 1 ? '' : 's'} before. Details filled in.`,
    usePrefill: 'Use these details',

    members: 'Additional members',
    addMember: '+ Add Member',
    memberName: 'Member name',
    memberPhoto: 'Member photo',
    noMembers: 'No additional members.',
    removeMember: 'Remove',
    memberCount: (n: number) => `+${n}`,
    membersWith: (n: number) => `${n} member${n === 1 ? '' : 's'} with them`,

    submit: 'Send for Approval',
    submitting: 'Sending…',
    sent: 'Sent for approval.',

    checkIn: 'Check In',
    checkOut: 'Check Out',
    checkingIn: 'Checking in…',
    checkingOut: 'Checking out…',
    waitingApproval: 'Waiting for approval',
    rejectedBy: (name: string) => `Rejected by ${name}`,
    approvedBy: (name: string) => `Approved by ${name}`,
    reason: 'Reason',
    visiting: 'Visiting',
    loggedAt: 'Logged',
  },

  // --- approvals (admin) ---
  approvals: {
    title: 'Approvals',
    pending: 'Pending',
    history: 'My decisions',
    noPending: 'Nothing waiting for approval.',
    noPendingHint: 'New requests appear here automatically.',
    noHistory: 'You have not decided on any visits yet.',

    approve: 'Approve',
    reject: 'Reject',
    approving: 'Approving…',
    rejecting: 'Rejecting…',

    rejectTitle: 'Reject this visitor?',
    rejectReason: 'Reason (optional)',
    rejectReasonPlaceholder: 'e.g. No appointment',
    confirmReject: 'Confirm reject',

    waitingFor: (text: string) => `Waiting ${text}`,
    unattended: 'Unattended',
    unattendedNote: 'Waiting more than 10 minutes',
    loggedBy: 'Logged by',
    tapToCall: 'Tap to call',
    tapPhotoToEnlarge: 'Tap a photo to enlarge',

    alreadyDecided: (status: string, name: string) => `Already ${status.toLowerCase()} by ${name}.`,
    decidedElsewhere: 'Another admin decided this one.',
  },

  // --- console (superadmin) ---
  console: {
    title: 'Console',
    tabs: {
      approvals: 'Approvals',
      dashboard: 'Dashboard',
      visits: 'Visits',
      users: 'Users',
    },

    dashboard: {
      title: 'Today',
      pending: 'Waiting',
      approved: 'Approved',
      inside: 'Inside',
      checkedOut: 'Left',
      rejected: 'Rejected',
      totalVisits: 'Total visits today',
      perAdmin: 'Decisions by admin',
      noDecisions: 'No decisions recorded today.',
      decisions: 'decisions',
      approvalsLabel: 'approved',
      rejectionsLabel: 'rejected',
      unattended: (n: number) => `${n} request${n === 1 ? '' : 's'} waiting over 10 minutes`,
      neverCheckedOut: 'Not checked out from earlier days',
      neverCheckedOutEmpty: 'Everyone from earlier days was checked out.',
    },

    visits: {
      title: 'Visit history',
      from: 'From',
      to: 'To',
      status: 'Status',
      approvedBy: 'Decided by',
      searchPlaceholder: 'Name, phone or purpose',
      allStatuses: 'All statuses',
      allAdmins: 'Anyone',
      none: 'No visits match these filters.',
      showing: (shown: number, total: number) => `Showing ${shown} of ${total}`,
      loadMore: 'Load more',
      auditTrail: 'Audit trail',
      exportCsv: 'Export CSV',
      expand: 'Details',
      collapse: 'Hide',
      photos: 'Photos',
      primaryVisitor: 'Visitor',
    },

    users: {
      title: 'Users',
      addUser: '+ Add user',
      name: 'Name',
      username: 'Username',
      password: 'Password',
      newPassword: 'New password',
      phone: 'Phone',
      roleLabel: 'Role',
      active: 'Active',
      inactive: 'Deactivated',
      deactivate: 'Deactivate',
      reactivate: 'Reactivate',
      resetPassword: 'Reset password',
      createTitle: 'Create user',
      editTitle: 'Edit user',
      created: 'User created.',
      updated: 'User updated.',
      passwordHint: 'At least 8 characters.',
      usernameHint: 'Letters, numbers, dot, underscore or hyphen.',
      confirmDeactivate: (name: string) => `Deactivate ${name}? They will be signed out and cannot log in.`,
      none: 'No users yet.',
      createdBy: 'Created by',
    },
  },

  // --- notifications ---
  notifications: {
    title: 'Notifications',
    open: 'Notifications',
    none: 'No notifications yet.',
    noneHint: 'Alerts about visitors will appear here.',
    markAllRead: 'Mark all read',
    loadMore: 'Load older',
    unreadOnly: 'Unread only',
    all: 'All',
    showingCount: (shown: number, total: number) => `Showing ${shown} of ${total}`,
    handled: 'Handled',

    enableTitle: 'Turn on alerts',
    enableBody: 'Get a notification on this phone the moment a visitor arrives.',
    enableButton: 'Turn on',
    enabling: 'Turning on…',
    enabled: 'Alerts are on for this device.',
    testButton: 'Send a test',
    testSent: 'Test sent — check your notification panel.',
    testNoDevice: 'No device is registered for alerts yet.',

    blockedTitle: 'Alerts are blocked',
    blockedBody:
      'This phone has blocked notifications for GatePass. Allow them in the browser’s site settings to get alerts.',
    installTitle: 'Install the app first',
    installBody:
      'On iPhone, alerts work only after adding GatePass to the Home Screen: tap Share, then “Add to Home Screen”, and open it from there.',
    unsupportedTitle: 'Alerts are not available',
    unsupportedBody:
      'This browser cannot show notifications. You will still see everything in this list.',
    serverOffTitle: 'Alerts are not set up',
    serverOffBody: 'Push notifications are not configured on the server yet.',
  },

  // --- audit actions ---
  action: {
    CREATED: 'Logged at gate',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    CHECKED_IN: 'Checked in',
    CHECKED_OUT: 'Checked out',
  } as Record<string, string>,

  // --- time ---
  time: {
    justNow: 'just now',
    minutes: (n: number) => `${n} min`,
    hours: (n: number) => `${n} hr`,
    hoursMinutes: (h: number, m: number) => `${h} hr ${m} min`,
  },
};

export default L;
