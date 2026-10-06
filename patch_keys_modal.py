import re

p = 'src/components/keys-modal.tsx'
s = open(p).read()
if 'Your Device ID' not in s:
    s = s.replace('''        {message && (
            <div className="border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#8fa3bd]">
              {message}
            </div>
          )}
        </div>''', '''        {message && (
            <div className="border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#8fa3bd]">
              {message}
            </div>
          )}
          
          <div className="border-t border-white/10 pt-4 mt-2">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#5f7089]">
              Admin Setup
            </span>
            <p className="mt-1 text-[11px] leading-snug text-[#5f7089]">
              To edit agent prompts globally, copy this Device ID and set it as <code>ADMIN_OWNER_ID</code> in Vercel.
            </p>
            <div className="mt-2 text-[#39d5ff] font-mono text-[10px] select-all bg-white/[0.03] border border-white/10 p-2">
               {typeof window !== "undefined" ? window.localStorage.getItem("neonslip.owner.v1") : ""}
            </div>
          </div>
        </div>''')
open(p, 'w').write(s)
print("Keys modal patched.")
