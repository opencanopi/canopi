declare const f: () => void
declare const kind: string
declare function Field(props: { onFocus: () => void; onChange: () => void }): null
export const Aliases = () => (
  <div onFocus={f} onBlur={f}>
    <input onChange={f} />
    <input type="text" onChange={f} />
    <input aria-label="colour" type="color" onChange={f} />
    <input type="checkbox" onChange={f} />
    <input aria-label="pick" type="radio" onChange={f} />
    <input type="file" onChange={f} />
    <textarea onChange={f} />
    <select onChange={f} />
    <Field onFocus={f} onChange={f} />
    <input onFocusIn={f} onInput={f} type={kind} />
    <input type={kind} onChange={f} />
  </div>
)
