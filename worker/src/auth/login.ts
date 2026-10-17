import { json } from "../http/security";
import { clientKey, type Limiter } from "../lib/limiter";
import { loginPage } from "./login-page";
import { createSession, destroySession, passwordMatches } from "./session";

const notAllowed = (allow: string) => new Response("Method Not Allowed", { status: 405, headers: { Allow: allow } });

export async function handleLogin(request: Request, env: Env): Promise<Response> {
	if (request.method === "GET") return loginPage(false);
	if (request.method !== "POST") return notAllowed("GET, POST");

	// 10 attempts per 60 s per IP, checked before any password work.
	const limiter = env.LOGIN_LIMITER as Limiter;
	const { success } = await limiter.limit({ key: clientKey(request) });
	if (!success) return json({ error: "rate_limited" }, 429);

	let candidate = "";
	try {
		const value = (await request.formData()).get("password");
		if (typeof value === "string") candidate = value;
	} catch {
		return loginPage(true, 400);
	}

	if (!(await passwordMatches(candidate, env.UI_PASSWORD))) return loginPage(true, 401);

	const cookie = await createSession(env.tpo_cdp);
	return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": cookie } });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return notAllowed("POST");
	const cleared = await destroySession(env.tpo_cdp, request);
	return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": cleared } });
}
