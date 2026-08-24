-- Relay-reported hub liveness. Defaults to false so every existing row starts
-- from "no bridge attached" rather than claiming a machine is up until the relay
-- says otherwise.
ALTER TABLE "devices" ADD COLUMN "online" BOOLEAN NOT NULL DEFAULT false;
