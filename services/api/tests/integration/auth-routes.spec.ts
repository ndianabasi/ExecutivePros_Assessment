import { test } from "@japa/runner";
import { useApiFixture } from "../macros.js";

test("public discovery, passwordless login, protected products, and logout route work", async ({
  assert,
  client
}) => {
  await useApiFixture();
  const discovered = await client.get('/v1/demo/users');
  assert.equal(discovered.status(), 200);
  assert.equal(discovered.body().data.length, 3);

  const unauthorized = await client.get('/v1/products');
  assert.equal(unauthorized.status(), 401);

  const loggedIn = await client.post('/v1/login').json({ user_id: 1 });
  assert.equal(loggedIn.status(), 200);
  const token = loggedIn.body().data.token as string;
  const products = await client
    .get('/v1/products')
    .header("Authorization", `Bearer ${token}`);
  assert.equal(products.status(), 200);
  assert.equal(products.body().data.length, 3);
  assert.equal(products.header("cache-control"), "no-store");

  const signedOut = await client
    .post('/v1/logout')
    .header("Authorization", `Bearer ${token}`);
  assert.equal(signedOut.status(), 204);
  const rejected = await client
    .get('/v1/products')
    .header("Authorization", `Bearer ${token}`);
  assert.equal(rejected.status(), 401);
});
