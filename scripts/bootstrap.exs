# Provisioning, rpc'd into the RUNNING web container by src/globalSetup.ts.
#
# Uses Lightning's own declarative bootstrapper: it creates the users/projects/
# workflows/triggers from a scenario and returns a machine-readable manifest
# (ids, api tokens, webhook paths). globalSetup injects the base64-encoded
# scenario into the placeholder in the code below before sending it.
#
# Requires the image to be built with Lightning.Bootstrap AND launched with
# ALLOW_BOOTSTRAP=true (the env gate). Writes /harness/manifest.json (host mount).

manifest =
  "__SCENARIO_B64__"
  |> Base.decode64!()
  |> Jason.decode!()
  |> Lightning.Bootstrap.create_from_map()
  |> Lightning.Bootstrap.manifest()

File.mkdir_p!("/harness")
File.write!("/harness/manifest.json", Jason.encode!(manifest))

:ok
