# Morsel Keys: a second control surface on the Launchkey's keybed port (MIDI Out).
#  - On a drum track it has Live translate the keys to the pads, as in Morsel: C3 = pad 1 ... D#4 = pad 16, repeating.
#  - It listens to the keys without taking them (they still play the track) and tells the Morsel surface, which uses
#    them in Step mode to pick the pad or note the steps write.


def create_instance(c_instance):
    from .surface import MorselKeysSurface

    return MorselKeysSurface(c_instance)
