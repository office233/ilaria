// Programs and backers shown in the "Backed by" strip.
// RULE: set `confirmed: true` ONLY after written acceptance (email / grant agreement) exists,
// and place the OFFICIAL logo file from the program's press kit at `logo`.
// Unconfirmed entries are never rendered. Do not redraw or recolour official marks.

export interface Backer {
  id: string;
  name: string;
  caption: string;
  logo: string;
  logoAlt: string;
  href?: string;
  confirmed: boolean;
  /** Pages where this backer may appear in addition to home and /investors. */
  extra?: ("ilaria" | "os")[];
}

export const backers: Backer[] = [
  {
    id: "eurohpc",
    name: "EuroHPC JU",
    caption: "Research & Compute awarded by the European High-Performance Computing Joint Undertaking (EuroHPC JU) — MareNostrum 5 ACC",
    logo: "/backers/eurohpc.svg",
    logoAlt: "EuroHPC Joint Undertaking and the flag of the European Union",
    href: "https://eurohpc-ju.europa.eu/",
    confirmed: false,
    extra: ["ilaria"],
  },
  {
    id: "microsoft",
    name: "Microsoft for Startups",
    caption: "Member of Microsoft for Startups Founders Hub",
    logo: "/backers/microsoft-for-startups.svg",
    logoAlt: "Microsoft for Startups",
    confirmed: false,
  },
  {
    id: "aws",
    name: "AWS Activate",
    caption: "Portfolio Member — AWS Activate",
    logo: "/backers/aws-activate.svg",
    logoAlt: "AWS Activate",
    confirmed: false,
  },
];

export const confirmedBackers = (page?: "ilaria" | "os") =>
  backers.filter((b) => b.confirmed && (!page || b.extra?.includes(page)));
