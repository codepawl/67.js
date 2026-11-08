Skinned character frames cost less CPU: palette math reads joint matrices in place and a normal pose allocates nothing, so eight animated characters update about 0.1 ms faster (#572)
