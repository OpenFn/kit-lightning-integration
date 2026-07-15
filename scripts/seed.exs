# Minimal seed, rpc'd into the RUNNING web container by src/globalSetup.ts.
#
# Deliberately tiny and built only from long-stable functions, so it works
# against any recent released Lightning image (not just images that include the
# unreleased Lightning.Bootstrap). It creates one superuser and mints a real API
# token; ALL workflow/project provisioning then happens over the public
# /api/provision HTTP API from the TypeScript side.
#
# Output: writes /harness/seed.json (host-mounted) with the token + user id.

email = "harness@openfn.org"

user =
  case Lightning.Accounts.get_user_by_email(email) do
    nil ->
      {:ok, user} =
        Lightning.Accounts.register_superuser(%{
          first_name: "Harry",
          last_name: "Harness",
          email: email,
          password: "harness-contract-tests-123"
        })

      user |> Lightning.Accounts.User.confirm_changeset() |> Lightning.Repo.update!()

    existing ->
      existing
  end

token = Lightning.Accounts.generate_api_token(user)

File.mkdir_p!("/harness")
File.write!("/harness/seed.json", Jason.encode!(%{api_token: token, user_id: user.id}))

:ok
