# Morsel for Live: a Launchkey Mini MK4 control surface that works like Morsel.
# Only the surface imports Live, so the other modules can be tested outside it.


def create_instance(c_instance):
    from .surface import MorselSurface

    return MorselSurface(c_instance)
