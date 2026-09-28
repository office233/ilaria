import { NextResponse } from "next/server";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { artistEarnings, getArtistByUserId, listArtistAlbums, listArtistTracks } from "@/lib/music/repository";

export const dynamic = "force-dynamic";

/**
 * Tot ce are nevoie `/creator/music`: artistul curent (sau `null` dacă
 * utilizatorul nu e încă artist — pagina arată starea „nu ești artist" cu
 * 200, nu 403, ca să poată afișa mesajul), piesele/albumele lui (toate
 * statusurile, e proprietarul) și câștigurile.
 */
export const GET = withErrorHandling(async function GET() {
    if (!isEnabled("music")) return frozenResponse("music");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const artist = await getArtistByUserId(userId);
    if (!artist) return NextResponse.json({ artist: null, tracks: [], albums: [], earnings: null });

    const [tracks, albums, earnings] = await Promise.all([
        listArtistTracks(userId, false),
        listArtistAlbums(userId, false),
        artistEarnings(userId),
    ]);
    return NextResponse.json({ artist, tracks, albums, earnings });
});
