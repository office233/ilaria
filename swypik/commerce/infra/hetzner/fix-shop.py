import pathlib
p = pathlib.Path("/opt/swypik/app/app/shop/page.tsx")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text('import { redirect } from "next/navigation";\n\nexport default function ShopRedirect() {\n  redirect("/explore");\n}\n')
print("OK:", p.read_text())
