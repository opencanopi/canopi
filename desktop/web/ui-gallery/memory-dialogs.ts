// The notices' message dialog, logged instead of shown; file dialogs are host commands that
// memory-backend.ts answers.
export async function message(text: string) { console.info('Gallery message:', text) }
