import { missingOptionalClips } from "@/content/frames.server";
import { Film } from "@/stage/Film";

export default function Home() {
  return <Film initialMissing={missingOptionalClips()} />;
}
