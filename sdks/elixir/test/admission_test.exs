defmodule Blok.AdmissionTest do
  use ExUnit.Case

  test "bounds queue admission and recovers after a job finishes" do
    parent = self()

    assert {:ok, :done} =
             Task.async(fn ->
               Blok.Admission.run(
                 fn ->
                   send(parent, :started)
                   Process.sleep(25)
                   :done
                 end,
                 500
               )
             end)
             |> Task.await()

    assert_receive :started
    assert %{active: 0, queued: 0, accepting: true} = Blok.Admission.snapshot()
  end
end
