# Provisioning, rpc'd into the RUNNING web container by src/globalSetup.ts.
#
# Uses Lightning's own declarative bootstrapper: it creates the users/projects/
# workflows/triggers from a scenario and returns a machine-readable manifest
# (ids, api tokens, webhook paths). globalSetup replaces __SCENARIO_B64__ with
# base64(scenario JSON) before sending it.
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
