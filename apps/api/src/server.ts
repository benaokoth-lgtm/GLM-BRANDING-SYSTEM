import 'dotenv/config';
import { app } from './app';

const port = Number(process.env.PORT) || 4100;
app.listen(port, () => {
  console.log(`GLM Branding POS API listening on :${port}`);
});
