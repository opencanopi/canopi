declare const designSessionStore: { sessionIdentity: { value: object } }
export const watch = () => designSessionStore.sessionIdentity.value
