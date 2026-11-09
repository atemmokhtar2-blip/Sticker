import { createServer } from "node:http";
import app from "./artifacts/api-server/src/app";

const port = Number(process.env.PORT ?? 3000);
const server = createServer(app);

server.listen(port, () => {
  console.log(`Sticker API listening on port ${port}`);
});
